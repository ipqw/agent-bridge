// Office environment on the client's PC (docs/ARCHITECTURE.md, «Офисные файлы»):
// pinned uv -> pinned CPython 3.12 (uv-managed, never the client's Python) -> venv -> packages from the hashed lock.
// Everything lives in <dataDir>/runtime; nothing is registered in the system, no admin rights needed.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RuntimeState = {
  state: "off" | "installing" | "ready" | "error";
  message: string; // Russian, for the client: «Скачиваю Python… 40 %», «Нет интернета — повторю через минуту»
  percent?: number;
  python?: string; // venv python, when ready
};
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; truncated: boolean }
export interface RunOptions { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal; maxOutput?: number }

export interface RuntimeOptions {
  dataDir: string;
  runtimeSrc: string; // core/runtime (resources/core/runtime in the installer)
  log?: (m: string) => void;
  uv?: string; // ready uv binary instead of the pinned download (SB_UV), for tests and debugging
  // test seams: the pinned sha256 stays the default, only the source moves
  uvAsset?: { url: string; sha256?: string };
  libreOfficeAsset?: { urls: string[]; sha256?: string };
  retryMs?: number; // after a network failure, default 60 s
}

const win = process.platform === "win32";

// uv: https://github.com/astral-sh/uv/releases/tag/0.13.2 — sha256 from the release's <asset>.sha256,
// re-checked by hashing the downloaded archives (20.10.2026).
export const UV_VERSION = "0.13.2";
const UV_ASSETS: Record<string, { name: string; sha256: string }> = {
  "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", sha256: "9cfb447a4027550f134753253fdffbcd35b79a66dd888260bf6776891916069e" },
  "linux-x64": { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "e14d48c117ec33601d6f860dda47aa5ea490d77a5a9ef770529c448fa6747d9f" },
};
// CPython build: uv verifies the python-build-standalone archive against the sha256 embedded in this uv version.
export const PYTHON_VERSION = "3.12.15";
// LibreOffice MSI (x86_64): sha256 from the mirror's .sha256, re-checked by hashing the full download (20.10.2026).
// The stable/ path rotates out after a few releases; the archive keeps the same file (26.2.6 = build 26.2.6.3).
export const LIBREOFFICE = {
  version: "26.2.6",
  sha256: "f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660",
  size: 373252096,
  urls: [
    "https://download.documentfoundation.org/libreoffice/stable/26.2.6/win/x86_64/LibreOffice_26.2.6_Win_x86-64.msi",
    "https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi",
  ],
};

const LOCK_FILE = "office-requirements.txt";
const NO_NET = "Нет интернета — повторю через минуту";
// bytes on disk after install (linux x86_64, measured 20.10: python 116 MB, uv cache + venv 680 MB) —
// only for the progress bar, which is capped below the phase end
const PYTHON_BYTES = 116e6;
const PACKAGES_BYTES = 680e6;

class NetError extends Error {}
class InstallError extends Error {} // message is already for the client

export class OfficeRuntime extends EventEmitter {
  private st: RuntimeState = { state: "off", message: "Не установлено" };
  private lo: RuntimeState = { state: "off", message: "Не установлен" };
  private running?: Promise<void>;
  private loRunning?: Promise<void>;
  private soffice?: string;
  private retryTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly root: string;

  constructor(private o: RuntimeOptions) {
    super();
    this.root = path.join(o.dataDir, "runtime");
  }

  status(): RuntimeState {
    return { ...this.st };
  }

  libreOfficeStatus(): RuntimeState {
    return { ...this.lo };
  }

  python(): string {
    const venv = path.join(this.root, "office-venv");
    return win ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  }

  // Never rejects: the outcome is in status(). Network failure -> "error" + one retry timer.
  ensure(): Promise<void> {
    this.closed = false;
    clearTimeout(this.retryTimer);
    this.running ??= this.install().finally(() => (this.running = undefined));
    return this.running;
  }

  // stop retrying (bridge shutdown, office disabled); a later ensure() starts over
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
  }

  private set(s: RuntimeState) {
    this.st = s;
    this.emit("change");
  }

  private log(m: string) {
    this.o.log?.(`office runtime: ${m}`);
  }

  private markerPath() {
    return path.join(this.root, "office-venv", ".bridge-ready.json");
  }

  private async install() {
    let lockSha: string;
    try {
      lockSha = sha256File(path.join(this.o.runtimeSrc, LOCK_FILE));
    } catch (e) {
      this.log(`lock missing: ${(e as Error).message}`);
      return this.set({ state: "error", message: "Повреждена установка моста: нет списка пакетов. Переустановите мост." });
    }
    const want = { lock: lockSha, python: PYTHON_VERSION };
    if (this.ready(want)) return this.set({ state: "ready", message: "Готово", percent: 100, python: this.python() });

    let release: (() => void) | undefined;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      release = await this.acquireLock();
      if (this.ready(want)) return this.set({ state: "ready", message: "Готово", percent: 100, python: this.python() });
      const uv = this.o.uv ?? process.env.SB_UV ?? (await this.fetchUv());
      const py = await this.installPython(uv);
      await this.installPackages(uv, py, lockSha);
      fs.writeFileSync(this.markerPath(), JSON.stringify(want));
      this.log(`ready: ${this.python()}`);
      this.set({ state: "ready", message: "Готово", percent: 100, python: this.python() });
    } catch (e) {
      const err = e as Error;
      this.log(`install failed: ${err.stack ?? err.message}`);
      if (err instanceof NetError) {
        this.set({ state: "error", message: NO_NET });
        if (!this.closed) {
          this.retryTimer = setTimeout(() => void this.ensure(), this.o.retryMs ?? 60_000);
          this.retryTimer.unref();
        }
      } else {
        this.set({ state: "error", message: err instanceof InstallError ? err.message : `Не удалось установить окружение: ${err.message}` });
      }
    } finally {
      release?.();
    }
  }

  private ready(want: { lock: string; python: string }): boolean {
    try {
      const m = JSON.parse(fs.readFileSync(this.markerPath(), "utf8"));
      return m.lock === want.lock && m.python === want.python && fs.existsSync(this.python());
    } catch {
      return false;
    }
  }

  // One installer per dataDir across processes (two bridge copies, parallel test files).
  private async acquireLock(): Promise<() => void> {
    const lock = path.join(this.root, ".install.lock");
    for (let waited = 0; ; waited += 500) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
        return () => fs.rmSync(lock, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      // the holder may be another instance in this very process: same pid means "wait", not "stale"
      const pid = Number(readText(lock) || 0);
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if ((pid && !alive(pid)) || (!pid && age > 10_000)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (waited === 0) this.set({ state: "installing", message: "Окружение уже ставится — жду" });
      if (waited > 3_600_000) throw new InstallError("Окружение ставится слишком долго другим процессом");
      await sleep(500);
    }
  }

  private uvEnv(): NodeJS.ProcessEnv {
    // the client's uv/pip/python settings must not leak in (UV_INDEX_URL, PIP_*, VIRTUAL_ENV, PYTHONPATH…);
    // proxy and certificate variables stay, uv honours them
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(UV_|PIP_|PYTHON|VIRTUAL_ENV|CONDA)/i.test(k)) env[k] = v;
    return {
      ...env,
      UV_NO_CONFIG: "1",
      UV_CACHE_DIR: path.join(this.root, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(this.root, "python"),
      UV_PYTHON_BIN_DIR: path.join(this.root, "python-bin"),
      UV_MANAGED_PYTHON: "1", // only uv-managed interpreters, never the client's Python (D4)
      // trust what Windows trusts (corporate proxies with their own root CA); integrity does not rest on TLS:
      // uv checks the CPython archive against its pinned sha256, pip sync runs with --require-hashes
      UV_SYSTEM_CERTS: "1",
      UV_NO_PROGRESS: "1",
    };
  }

  private async fetchUv(): Promise<string> {
    const key = `${process.platform}-${process.arch}`;
    const asset = UV_ASSETS[key];
    if (!asset) throw new InstallError(`Офисные файлы не поддерживаются на этой системе (${key})`);
    const dir = path.join(this.root, "uv");
    const exe = path.join(dir, win ? "uv.exe" : "uv");
    const stamp = path.join(dir, ".version");
    const sha = this.o.uvAsset?.sha256 ?? asset.sha256;
    if (fs.existsSync(exe) && readText(stamp) === `${UV_VERSION} ${sha}`) return exe;

    const url = this.o.uvAsset?.url ?? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.name}`;
    const downloads = path.join(this.root, "downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const archive = path.join(downloads, asset.name);
    const step = (p: number) => this.set({ state: "installing", message: `Скачиваю установщик Python… ${p} %`, percent: p });
    step(0);
    const got = await download(url, archive, (p) => step(Math.floor(p / 10)));
    if (got !== sha) {
      fs.rmSync(archive, { force: true });
      this.log(`uv sha256 mismatch: ${got} != ${sha} (${url})`);
      throw new InstallError("Скачанный установщик Python не прошёл проверку подлинности — ничего не установлено");
    }
    const tmp = fs.mkdtempSync(path.join(this.root, "uv-tmp-"));
    try {
      // Windows 10+ ships bsdtar as System32\tar.exe; it unpacks zip too
      const tar = win ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      const x = await run(tar, ["-xf", archive, "-C", tmp]);
      if (x.code !== 0) throw new InstallError(`Не удалось распаковать установщик Python: ${x.stderr.trim().split(/\r?\n/).pop()}`);
      const found = findFile(tmp, win ? "uv.exe" : "uv", 3);
      if (!found) throw new InstallError("В архиве установщика Python нет uv");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(found, exe);
      if (!win) fs.chmodSync(exe, 0o755);
      fs.writeFileSync(stamp, `${UV_VERSION} ${sha}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
    }
    this.log(`uv ${UV_VERSION} -> ${exe} (sha256 ok)`);
    return exe;
  }

  private async installPython(uv: string): Promise<string> {
    const env = this.uvEnv();
    const pyDir = path.join(this.root, "python");
    const stop = this.progress(pyDir, PYTHON_BYTES, 10, 40, "Скачиваю Python…");
    try {
      await this.uvRun(uv, ["python", "install", PYTHON_VERSION, "--no-bin", "--no-registry", "--compile-bytecode"], env);
    } finally {
      stop();
    }
    const { stdout } = await this.uvRun(uv, ["python", "find", PYTHON_VERSION, "--managed-python", "--no-project"], {
      ...env,
      UV_PYTHON_DOWNLOADS: "never",
    });
    const py = stdout.trim().split(/\r?\n/).pop() ?? "";
    if (!py || !fs.existsSync(py) || !isInside(fs.realpathSync.native(py), fs.realpathSync.native(pyDir))) throw new InstallError(`Python нашёлся не там, где его ставил мост: ${py}`);
    return py;
  }

  private async installPackages(uv: string, py: string, lockSha: string) {
    const env = { ...this.uvEnv(), UV_PYTHON_DOWNLOADS: "never" };
    const venv = path.join(this.root, "office-venv");
    if (readText(path.join(venv, ".bridge-python")) !== PYTHON_VERSION || !fs.existsSync(this.python())) {
      this.set({ state: "installing", message: "Готовлю окружение…", percent: 40 });
      await this.uvRun(uv, ["venv", "--clear", "--no-project", "--python", py, venv], env);
      fs.writeFileSync(path.join(venv, ".bridge-python"), PYTHON_VERSION);
    }
    fs.rmSync(this.markerPath(), { force: true });
    const stop = this.progress([path.join(this.root, "cache"), venv], PACKAGES_BYTES, 45, 99, "Скачиваю пакеты…");
    try {
      // sync, not install: the venv ends up exactly as the lock says (a package dropped from the lock is removed)
      await this.uvRun(
        uv,
        ["pip", "sync", "--python", this.python(), "--require-hashes", "--only-binary", ":all:", "--compile-bytecode", path.join(this.o.runtimeSrc, LOCK_FILE)],
        env,
      );
    } finally {
      stop();
    }
    this.log(`packages synced (lock ${lockSha.slice(0, 12)})`);
  }

  private async uvRun(uv: string, args: string[], env: NodeJS.ProcessEnv) {
    this.log(`uv ${args.join(" ")}`);
    const r = await run(uv, args, { env, cwd: this.root }).catch((e: Error) => {
      throw new InstallError(`Не удалось запустить установщик Python: ${e.message}`);
    });
    if (r.code !== 0) {
      const tail = r.stderr.trim().split(/\r?\n/).slice(-8).join("\n");
      this.log(`uv ${args[0]} ${args[1] ?? ""} exited ${r.code}:\n${tail}`);
      if (NET_RE.test(r.stderr)) throw new NetError(tail);
      throw new InstallError(`Не удалось установить окружение (uv ${args[0]} ${args[1] ?? ""}): ${tail.split("\n").pop()}`);
    }
    return r;
  }

  // progress by bytes on disk: uv prints no progress without a terminal
  private progress(dirs: string | string[], expected: number, from: number, to: number, label: string): () => void {
    let stopped = false;
    let busy = false;
    const t = setInterval(async () => {
      if (busy || stopped) return;
      busy = true;
      let size = 0;
      for (const d of [dirs].flat()) size += await dirSize(d);
      busy = false;
      if (stopped) return;
      const p = Math.min(to - 1, from + Math.floor(((to - from) * size) / expected));
      this.set({ state: "installing", message: `${label} ${p} %`, percent: p });
    }, 1000);
    t.unref();
    this.set({ state: "installing", message: `${label} ${from} %`, percent: from });
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }

  // python -I -B -X utf8 <runtimeSrc>/<file> ...args, clean environment, process tree killed on timeout/abort.
  // An absolute `file` runs as is: a user-approved agent script outside the pool (D7).
  runPy(file: string, args: string[], o: RunOptions): Promise<RunResult> {
    const py = this.python();
    if (!fs.existsSync(py)) return Promise.reject(new Error("Офисное окружение ещё не установлено"));
    const script = path.isAbsolute(file) ? file : path.join(this.o.runtimeSrc, file);
    return runTree(py, ["-I", "-B", "-X", "utf8", script, ...args], { ...o, env: { ...pyEnv(path.dirname(py)), ...o.env } });
  }

  libreOffice(): { installed: boolean; soffice?: string } {
    if (!this.soffice || !fs.existsSync(this.soffice)) this.soffice = findSoffice(path.join(this.o.dataDir, "libreoffice"));
    return this.soffice ? { installed: true, soffice: this.soffice } : { installed: false };
  }

  // After the client's consent (п. 6). Rejects with a Russian message; progress in libreOfficeStatus().
  installLibreOffice(): Promise<void> {
    this.loRunning ??= this.installLo().finally(() => (this.loRunning = undefined));
    return this.loRunning;
  }

  private setLo(s: RuntimeState) {
    this.lo = s;
    this.emit("change");
  }

  private async installLo() {
    try {
      if (!win) throw new InstallError("LibreOffice мост ставит только на Windows");
      const sha = this.o.libreOfficeAsset?.sha256 ?? LIBREOFFICE.sha256;
      const urls = this.o.libreOfficeAsset?.urls ?? LIBREOFFICE.urls;
      const given = process.env.SB_LIBREOFFICE_MSI; // pre-downloaded MSI (CI cache); still verified
      let msi: string;
      if (given) {
        msi = given;
        this.setLo({ state: "installing", message: "Проверяю LibreOffice…", percent: 0 });
        if (sha256File(msi) !== sha) throw new InstallError("Файл LibreOffice не прошёл проверку подлинности — ничего не установлено");
      } else {
        const downloads = path.join(this.root, "downloads");
        fs.mkdirSync(downloads, { recursive: true });
        msi = path.join(downloads, `LibreOffice_${LIBREOFFICE.version}_Win_x86-64.msi`);
        let got = fs.existsSync(msi) ? sha256File(msi) : "";
        for (let i = 0; got !== sha && i < urls.length; i++) {
          this.setLo({ state: "installing", message: "Скачиваю LibreOffice… 0 %", percent: 0 });
          try {
            got = await download(urls[i], msi, (p) => this.setLo({ state: "installing", message: `Скачиваю LibreOffice… ${Math.round(p * 0.9)} %`, percent: Math.round(p * 0.9) }));
          } catch (e) {
            this.log(`LibreOffice download ${urls[i]}: ${(e as Error).message}`);
            if (i === urls.length - 1) throw e;
          }
        }
        if (got !== sha) {
          fs.rmSync(msi, { force: true });
          throw new InstallError("Скачанный LibreOffice не прошёл проверку подлинности — ничего не установлено");
        }
      }
      this.setLo({ state: "installing", message: "Распаковываю LibreOffice… 90 %", percent: 90 });
      const target = path.join(this.o.dataDir, "libreoffice");
      this.soffice = undefined;
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      const msiLog = path.join(this.root, "libreoffice-msi.log");
      // administrative install = unpack without registering anything; msiexec parses its own command line,
      // so PROPERTY="value" has to reach it verbatim
      const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const r = await run(path.join(sys32, "msiexec.exe"), ["/a", `"${msi}"`, "/qn", "/l*v", `"${msiLog}"`, `TARGETDIR="${target}"`], { verbatim: true });
      if (r.code !== 0 && r.code !== 3010) {
        fs.rmSync(target, { recursive: true, force: true });
        this.log(`msiexec exited ${r.code}, log: ${msiLog}`);
        throw new InstallError(r.code === 1618 ? "Сейчас идёт другая установка Windows — повторите позже" : `LibreOffice не распаковался (код ${r.code})`);
      }
      const soffice = findSoffice(target);
      if (!soffice) throw new InstallError("LibreOffice распаковался, но soffice.exe не найден");
      if (!given) fs.rmSync(msi, { force: true });
      this.log(`LibreOffice ${LIBREOFFICE.version} -> ${soffice}`);
      this.setLo({ state: "ready", message: "Установлен", percent: 100 });
    } catch (e) {
      const err = e as Error;
      this.log(`LibreOffice install failed: ${err.stack ?? err.message}`);
      const message = err instanceof NetError ? "Нет интернета — LibreOffice не скачался" : err instanceof InstallError ? err.message : `LibreOffice не установился: ${err.message}`;
      this.setLo({ state: "error", message });
      throw new Error(message);
    }
  }
}

// ---------- process helpers ----------

export function killTree(pid: number): void {
  if (win) {
    const tk = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    tk.on("error", () => {
      try {
        process.kill(pid);
      } catch {}
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the child leads its own group (spawned detached)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function pyEnv(binDir: string): Record<string, string> {
  if (win) {
    const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const env: Record<string, string> = {
      SystemRoot: sysRoot,
      windir: process.env.windir ?? process.env.WINDIR ?? sysRoot,
      PATH: [binDir, path.join(sysRoot, "System32"), sysRoot].join(";"),
    };
    for (const k of ["TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
    return env;
  }
  const env: Record<string, string> = { PATH: `${binDir}:/usr/bin:/bin`, LANG: "C.UTF-8" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

// Head + tail of each stream: the tail keeps the result line (office_ops JSON, guard verdicts).
class Capped {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  dropped = 0;
  constructor(private max: number) {}
  push(b: Buffer) {
    const half = Math.floor(this.max / 2);
    if (this.headLen < half) {
      const take = b.subarray(0, half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      b = b.subarray(take.length);
    }
    if (!b.length) return;
    this.tail.push(b);
    this.tailLen += b.length;
    const keep = this.max - half;
    while (this.tailLen - this.tail[0].length >= keep) {
      this.tailLen -= this.tail[0].length;
      this.dropped += this.tail.shift()!.length;
    }
    if (this.tailLen > keep) {
      const cut = this.tailLen - keep;
      this.tail[0] = this.tail[0].subarray(cut);
      this.tailLen -= cut;
      this.dropped += cut;
    }
  }
  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.dropped ? `${head}\n…[вывод обрезан: ${this.dropped} байт]…\n${tail}` : head + tail;
  }
}

function runTree(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  const max = o.maxOutput ?? 64 * 1024;
  if (o.signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true, truncated: false });
  return new Promise((resolve) => {
    const out = new Capped(max);
    const err = new Capped(max);
    let timedOut = false;
    let aborted = false;
    let done = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !win });
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: `spawn error: ${(e as Error).message}`, timedOut, aborted, truncated: false });
    }
    const kill = () => child.pid && killTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    const finish = (code: number | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (extra) err.push(Buffer.from(extra));
      resolve({ code, stdout: out.text(), stderr: err.text(), timedOut, aborted, truncated: out.dropped + err.dropped > 0 });
    };
    child.on("error", (e) => finish(null, `spawn error: ${e.message}`));
    child.on("close", (code) => finish(timedOut || aborted ? null : code));
    // a grandchild that escaped the kill may hold the pipes open: do not wait for it forever
    child.on("exit", (code) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(timedOut || aborted ? null : code);
      }, 2000).unref();
    });
  });
}

function run(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; verbatim?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // verbatim: args go to the command line as written (Windows tools that parse quotes themselves)
    const p = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: o.verbatim });
    let stdout = "";
    let stderr = "";
    p.stdout!.on("data", (d) => (stdout += d));
    p.stderr!.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------- download / fs helpers ----------

const NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ABORT_ERR"]);
// uv's wording for transport failures (reqwest / hyper / OS errors)
const NET_RE = /error sending request|failed to fetch|failed to download|dns error|tcp connect|connection (refused|reset|closed)|timed out|network is unreachable|could not resolve|os error (10060|10061|11001|101|110|111)/i;

// streams url -> file, returns sha256 of what was written; network trouble -> NetError
async function download(url: string, file: string, onPercent: (p: number) => void): Promise<string> {
  const ctl = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const poke = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(), 60_000);
  };
  poke();
  const hash = crypto.createHash("sha256");
  const tmp = `${file}.part`;
  let fd: number | undefined;
  try {
    let r: Response;
    try {
      r = await fetch(url, { redirect: "follow", signal: ctl.signal });
    } catch (e) {
      throw asNet(e);
    }
    if (!r.ok || !r.body) {
      if (r.status >= 500) throw new NetError(`${url}: HTTP ${r.status}`);
      throw new InstallError(`Не удалось скачать файл: сервер ответил ${r.status}`);
    }
    const total = Number(r.headers.get("content-length") ?? 0);
    fd = fs.openSync(tmp, "w");
    let got = 0;
    let last = -1;
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        poke();
        hash.update(chunk);
        fs.writeSync(fd, chunk);
        got += chunk.length;
        const p = total ? Math.floor((100 * got) / total) : 0;
        if (p !== last) onPercent((last = p));
      }
    } catch (e) {
      throw asNet(e);
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    return hash.digest("hex");
  } finally {
    clearTimeout(idle);
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

function asNet(e: unknown): Error {
  const err = e as Error & { cause?: { code?: string }; code?: string; name?: string };
  const code = err.cause?.code ?? err.code ?? (err.name === "AbortError" ? "ABORT_ERR" : "");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
    return new InstallError("Не удаётся проверить сертификат сервера загрузки — похоже, сеть подменяет HTTPS (прокси)");
  if (NET_CODES.has(code) || err.message === "fetch failed") return new NetError(`${err.message} ${code}`);
  return err;
}

function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function findFile(dir: string, name: string, depth: number): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  if (depth <= 0) return undefined;
  for (const e of entries) if (e.isDirectory()) {
    const f = findFile(path.join(dir, e.name), name, depth - 1);
    if (f) return f;
  }
  return undefined;
}

// soffice inside an unpacked LibreOffice tree: <…>/program/soffice(.exe), at most 5 levels down
function findSoffice(dir: string, depth = 5): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (path.basename(dir).toLowerCase() === "program") {
    const exe = entries.find((e) => e.isFile() && e.name.toLowerCase() === (win ? "soffice.exe" : "soffice"));
    if (exe) return path.join(dir, exe.name);
  }
  if (depth <= 0) return undefined;
  for (const e of entries) if (e.isDirectory()) {
    const f = findSoffice(path.join(dir, e.name), depth - 1);
    if (f) return f;
  }
  return undefined;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += await fs.promises.stat(p).then((s) => s.size, () => 0);
  }
  return total;
}

function isInside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
