// Office runtime (T2): pinned uv -> CPython 3.12 -> venv -> hashed lock, for real on this OS (needs network).
// dataDir core/.cache/test-office-runtime is a cache kept between runs, so a second run downloads nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { OfficeRuntime, PYTHON_VERSION, UV_VERSION } from "../src/office/runtime.ts";

delete process.env.SB_UV; // the pinned download is what is tested here
const win = process.platform === "win32";
const supported = (win || process.platform === "linux") && process.arch === "x64";
const skip = supported ? false : "office runtime is pinned for windows/linux x64 only";
const runtimeSrc = path.resolve("runtime");
const dataDir = path.resolve(".cache/test-office-runtime");
const uvBin = path.join(dataDir, "runtime", "uv", win ? "uv.exe" : "uv");

const tmp = (p: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inside = (p: string, dir: string) => !path.relative(dir, p).startsWith("..");

async function waitFor(cond: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (cond()) return true;
  return cond();
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closedPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  return port;
}

// protects=AC1: pinned uv (sha256-checked) installs its pinned CPython 3.12 and the hashed lock into dataDir, never using the system Python; fails_when=uv pin/sha, Python pin, lock or venv layout breaks; no_claim=Windows install (Windows CI), client networks and proxies
test("ensure installs pinned uv, CPython 3.12 and the locked packages", { skip, timeout: 1_200_000 }, async () => {
  const logs: string[] = [];
  const rt = new OfficeRuntime({ dataDir, runtimeSrc, log: (m) => logs.push(m) });
  const messages: string[] = [];
  rt.on("change", () => messages.push(rt.status().message));
  const t0 = Date.now();
  await rt.ensure();
  const st = rt.status();
  assert.equal(st.state, "ready", `${JSON.stringify(st)}\n${logs.join("\n")}`);
  assert.equal(st.python, rt.python());
  console.log(`office runtime ensure: ${((Date.now() - t0) / 1000).toFixed(1)} s (${messages.length > 1 ? "installed" : "cached"})`);
  assert.equal(execFileSync(uvBin, ["--version"]).toString().split(" ")[1], UV_VERSION);
  const probe = "import sys, json, openpyxl, docx, pptx, pandas, markitdown, pypdf, pypdfium2, PIL, reportlab, lxml, defusedxml, xlrd; print(json.dumps({'v': sys.version.split()[0], 'base': sys.base_prefix, 'prefix': sys.prefix}))";
  const info = JSON.parse(execFileSync(rt.python(), ["-I", "-c", probe]).toString());
  assert.equal(info.v, PYTHON_VERSION);
  assert.ok(inside(fs.realpathSync(info.base), fs.realpathSync(path.join(dataDir, "runtime", "python"))), `base_prefix ${info.base}`);
  assert.ok(inside(info.prefix, path.join(dataDir, "runtime", "office-venv")), `prefix ${info.prefix}`);
  if (win) execFileSync(rt.python(), ["-I", "-c", "import win32com.client, pythoncom, winreg"]);
});

// protects=idempotent enable: with the marker in place ensure() runs no installer and touches no network; fails_when=marker check breaks and every start re-installs; no_claim=manual damage inside the venv
test("second ensure downloads nothing", { skip, timeout: 60_000 }, async () => {
  const rt = new OfficeRuntime({ dataDir, runtimeSrc, uvAsset: { url: `http://127.0.0.1:${await closedPort()}/uv` } });
  const seen: string[] = [];
  rt.on("change", () => seen.push(rt.status().state));
  const t0 = Date.now();
  await rt.ensure();
  assert.equal(rt.status().state, "ready");
  assert.deepEqual(seen, ["ready"]);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

// protects=only the pinned uv archive is ever unpacked and run; fails_when=sha256 check skipped or done after unpacking; no_claim=TLS interception beyond what the hash catches
test("uv archive with a wrong sha256 -> error, nothing installed", { skip, timeout: 60_000 }, async () => {
  const srv = http.createServer((_req, res) => res.end(Buffer.alloc(64 * 1024, 7)));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const dd = tmp("sb-office-sha-");
  try {
    const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc, uvAsset: { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/uv.tar.gz` } });
    await rt.ensure();
    rt.close();
    assert.equal(rt.status().state, "error");
    assert.match(rt.status().message, /не прошёл проверку подлинности/);
    for (const d of ["uv", "python", "office-venv"]) assert.ok(!fs.existsSync(path.join(dd, "runtime", d)), `${d} must not exist`);
    assert.deepEqual(fs.readdirSync(path.join(dd, "runtime", "downloads")), []);
  } finally {
    srv.close();
    fs.rmSync(dd, { recursive: true, force: true });
  }
});

// protects=offline enable says «Нет интернета — повторю через минуту» and retries by itself; fails_when=network errors surface as generic failures or the retry timer is lost; no_claim=the real 60 s interval
test("no network -> «Нет интернета…» and a retry", { skip, timeout: 60_000 }, async () => {
  const dd = tmp("sb-office-net-");
  try {
    const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc, uvAsset: { url: `http://127.0.0.1:${await closedPort()}/uv.tar.gz` }, retryMs: 300 });
    let attempts = 0;
    rt.on("change", () => {
      const s = rt.status();
      if (s.state === "installing" && s.percent === 0) attempts++;
    });
    await rt.ensure();
    assert.equal(rt.status().state, "error");
    assert.equal(rt.status().message, "Нет интернета — повторю через минуту");
    assert.ok(await waitFor(() => attempts >= 2, 10_000), `retries: ${attempts}`);
    rt.close();
  } finally {
    fs.rmSync(dd, { recursive: true, force: true });
  }
});

// protects=uv's own transport failures (Python download) are recognised as «нет интернета», not as a broken install; fails_when=uv wording drifts away from the network regex; no_claim=PyPI-step wording (same uv client)
test("uv network failure during Python install -> «Нет интернета…»", { skip, timeout: 300_000 }, async () => {
  const dd = tmp("sb-office-uvnet-");
  const saved = { ...process.env };
  const proxy = `http://127.0.0.1:${await closedPort()}`;
  Object.assign(process.env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy });
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  try {
    const logs: string[] = [];
    const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc, uv: uvBin, log: (m) => logs.push(m), retryMs: 600_000 });
    await rt.ensure();
    rt.close();
    assert.equal(rt.status().message, "Нет интернета — повторю через минуту", logs.join("\n"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dd, { recursive: true, force: true });
  }
});

// lock fragment for one package: its "name==" line with the hash lines under it
function lockBlock(lock: string, name: string): string {
  const lines = lock.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${name}==`));
  assert.ok(i >= 0, `${name} in lock`);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && /^\s+--hash=/.test(lines[j]); j++) out.push(lines[j]);
  return out.join("\n").replace(/ \\$/, "") + "\n";
}

// protects=a new lock (bridge update) re-syncs the venv to exactly that lock, dropped packages are removed; fails_when=marker ignores the lock hash or the install leaves stale packages; no_claim=Python version bump (venv --clear path)
test("changed lock re-syncs the packages", { skip, timeout: 600_000 }, async () => {
  const lock = fs.readFileSync(path.join(runtimeSrc, "office-requirements.txt"), "utf8");
  const dd = path.resolve(".cache/test-office-runtime-lock");
  const srcA = tmp("sb-office-lockA-");
  const srcB = tmp("sb-office-lockB-");
  fs.writeFileSync(path.join(srcA, "office-requirements.txt"), lockBlock(lock, "defusedxml"));
  fs.writeFileSync(path.join(srcB, "office-requirements.txt"), lockBlock(lock, "defusedxml") + lockBlock(lock, "et-xmlfile"));
  const has = (py: string, mod: string) => {
    try {
      execFileSync(py, ["-I", "-c", `import ${mod}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  try {
    const logs: string[] = [];
    const a = new OfficeRuntime({ dataDir: dd, runtimeSrc: srcA, uv: uvBin, log: (m) => logs.push(m) });
    await a.ensure();
    assert.equal(a.status().state, "ready", logs.join("\n"));
    assert.ok(has(a.python(), "defusedxml") && !has(a.python(), "et_xmlfile"));

    const b = new OfficeRuntime({ dataDir: dd, runtimeSrc: srcB, uv: uvBin, log: (m) => logs.push(m) });
    const states: string[] = [];
    b.on("change", () => states.push(b.status().state));
    await b.ensure();
    assert.equal(b.status().state, "ready", logs.join("\n"));
    assert.ok(states.includes("installing"), "lock change must re-run the installer");
    assert.ok(has(b.python(), "et_xmlfile"));

    await new OfficeRuntime({ dataDir: dd, runtimeSrc: srcA, uv: uvBin }).ensure();
    assert.ok(!has(a.python(), "et_xmlfile"), "package dropped from the lock is removed");
  } finally {
    fs.rmSync(srcA, { recursive: true, force: true });
    fs.rmSync(srcB, { recursive: true, force: true });
  }
});

// ---------- runPy ----------

const scripts = tmp("sb-office-py-");
fs.writeFileSync(
  path.join(scripts, "tree.py"),
  [
    "import subprocess, sys, time",
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
    "open(sys.argv[1], 'w').write(str(child.pid))",
    "print('started', flush=True)",
    "time.sleep(120)",
  ].join("\n"),
);
fs.writeFileSync(path.join(scripts, "loud.py"), "import sys\nsys.stdout.write('x' * 200000 + '\\n')\nprint('RESULT-LINE')\n");
fs.writeFileSync(
  path.join(scripts, "env.py"),
  // '=' keys are Windows per-drive cwd markers the OS injects into every child; not variables we pass and not removable via env.
  "import json, os, sys\nenv = sorted(k for k in os.environ if not k.startswith('='))\nhead = (os.environ.get('PATH') or '').split(os.pathsep)[0]\nprint(json.dumps({'env': env, 'pathHead': head, 'isolated': sys.flags.isolated, 'nobytecode': sys.flags.dont_write_bytecode, 'utf8': sys.flags.utf8_mode, 'cwd': os.getcwd()}))\n",
);
const runner = () => new OfficeRuntime({ dataDir, runtimeSrc: scripts });

async function treeRun(o: { timeoutMs: number; signal?: AbortSignal }) {
  const pidFile = path.join(scripts, `pid-${Date.now()}`);
  const t0 = Date.now();
  const r = await runner().runPy("tree.py", [pidFile], o);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  return { r, grandchild, ms: Date.now() - t0 };
}

// protects=R8 timeout kills the whole script tree, no orphaned writer; fails_when=only the direct child dies or no process group is made; no_claim=Windows taskkill /T (Windows CI)
test("runPy: timeout kills the process tree", { skip, timeout: 60_000 }, async () => {
  const { r, grandchild, ms } = await treeRun({ timeoutMs: 3000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.match(r.stdout, /started/);
  assert.ok(ms < 15_000, `took ${ms} ms`);
  assert.ok(await waitFor(() => !alive(grandchild), 5000), "grandchild still alive");
});

// protects=agent hang-up (AbortSignal) kills the script tree; fails_when=signal ignored or only the child killed; no_claim=gate wiring of extra.signal (T1/T6)
test("runPy: abort kills the process tree", { skip, timeout: 60_000 }, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2500);
  const { r, grandchild } = await treeRun({ timeoutMs: 60_000, signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.ok(await waitFor(() => !alive(grandchild), 5000), "grandchild still alive");
});

// protects=output cap (64 KB default) with the tail kept, so the result line survives and truncation is flagged; fails_when=unbounded buffering or the tail is dropped; no_claim=exact cut on a multi-byte boundary
test("runPy: output is capped, the last line survives", { skip, timeout: 60_000 }, async () => {
  const r = await runner().runPy("loud.py", [], { timeoutMs: 30_000 });
  assert.equal(r.code, 0);
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 66 * 1024, `stdout ${r.stdout.length}`);
  assert.ok(r.stdout.trimEnd().endsWith("RESULT-LINE"));
  const small = await runner().runPy("loud.py", [], { timeoutMs: 30_000, maxOutput: 1000 });
  assert.ok(small.stdout.length < 1100 && small.truncated);
});

// protects=clean start: -I -B -X utf8, PATH from the venv, and none of the parent's Python config or bridge secrets inherited; fails_when=env inherited or flags dropped; no_claim=which benign system variables Windows itself injects (HOMEDRIVE, =C:, …)
test("runPy: isolated interpreter and clean environment", { skip, timeout: 60_000 }, async () => {
  process.env.PYTHONPATH = "/nonexistent";
  process.env.PYTHONSTARTUP = "/nonexistent";
  process.env.SB_TEST_SECRET = "secret";
  try {
    const cwd = tmp("sb-office-cwd-");
    const rt = runner();
    const r = await rt.runPy("env.py", [], { timeoutMs: 30_000, cwd });
    assert.equal(r.code, 0, r.stderr);
    const info = JSON.parse(r.stdout.trim().split("\n").pop()!);
    // The planted canaries prove the child does NOT inherit the parent environment; benign OS-injected
    // vars (HOMEDRIVE, =C:) are tolerated rather than enumerated — that list is not a stable claim.
    const keys: string[] = info.env.map((k: string) => k.toUpperCase());
    const danger = (k: string) => k.startsWith("PYTHON") || k.startsWith("SB_") || k.startsWith("PIP_") || k === "VIRTUAL_ENV" || k === "CONDA_PREFIX";
    const leaked = keys.filter(danger);
    assert.deepEqual(leaked, [], `inherited Python/bridge variables: ${leaked.join(", ")}`);
    assert.ok(keys.includes("PATH"), "PATH must be set");
    assert.equal(info.isolated, 1);
    assert.equal(info.nobytecode, 1);
    assert.equal(info.utf8, 1);
    // PATH starts with the venv bin dir, so the script runs against our interpreter, not an inherited one
    assert.ok(info.pathHead && fs.realpathSync(info.pathHead) === fs.realpathSync(path.dirname(rt.python())), `PATH head ${info.pathHead}`);
    assert.equal(fs.realpathSync(info.cwd), cwd);
  } finally {
    delete process.env.PYTHONPATH;
    delete process.env.PYTHONSTARTUP;
    delete process.env.SB_TEST_SECRET;
  }
});

// ---------- LibreOffice ----------

// protects=libreOffice() finds soffice only as <dataDir>/libreoffice/…/program/soffice(.exe); fails_when=lookup depth or name breaks after msiexec /a; no_claim=the real MSI layout (Windows CI with SB_LIBREOFFICE_MSI)
test("libreOffice() finds an unpacked soffice", { timeout: 10_000 }, () => {
  const dd = tmp("sb-office-lo-");
  try {
    const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc });
    assert.deepEqual(rt.libreOffice(), { installed: false });
    const prog = path.join(dd, "libreoffice", "LibreOffice", "program");
    fs.mkdirSync(prog, { recursive: true });
    fs.writeFileSync(path.join(prog, win ? "soffice.exe" : "soffice"), "");
    assert.deepEqual(rt.libreOffice(), { installed: true, soffice: path.join(prog, win ? "soffice.exe" : "soffice") });
  } finally {
    fs.rmSync(dd, { recursive: true, force: true });
  }
});

// protects=LibreOffice is installed only on Windows, with a plain message elsewhere; fails_when=msiexec path runs on another OS; no_claim=the Windows path
test("installLibreOffice outside Windows -> plain error", { skip: win ? "Windows runs the real install" : false, timeout: 10_000 }, async () => {
  const dd = tmp("sb-office-lo-");
  const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc });
  await assert.rejects(rt.installLibreOffice(), /только на Windows/);
  assert.equal(rt.libreOfficeStatus().state, "error");
  fs.rmSync(dd, { recursive: true, force: true });
});

// protects=AC9/п. 6 only the pinned MSI is unpacked; fails_when=sha check skipped; no_claim=download from the TDF mirror
test("LibreOffice MSI with a wrong sha256 -> error, nothing unpacked", { skip: win ? false : "Windows only", timeout: 60_000 }, async () => {
  const srv = http.createServer((_req, res) => res.end(Buffer.alloc(64 * 1024, 7)));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const dd = tmp("sb-office-lomsi-");
  try {
    const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc, libreOfficeAsset: { urls: [`http://127.0.0.1:${(srv.address() as { port: number }).port}/lo.msi`] } });
    const saved = process.env.SB_LIBREOFFICE_MSI;
    delete process.env.SB_LIBREOFFICE_MSI;
    try {
      await assert.rejects(rt.installLibreOffice(), /проверку подлинности/);
    } finally {
      if (saved !== undefined) process.env.SB_LIBREOFFICE_MSI = saved;
    }
    assert.ok(!fs.existsSync(path.join(dd, "libreoffice")));
    assert.equal(rt.libreOffice().installed, false);
  } finally {
    srv.close();
    fs.rmSync(dd, { recursive: true, force: true });
  }
});

// protects=AC9/п. 6 consent path: pinned MSI (sha256) unpacked by msiexec /a without admin, soffice found; fails_when=msiexec quoting, TARGETDIR layout or lookup breaks; no_claim=download speed from the mirror (CI passes a cached MSI)
test("installLibreOffice unpacks the pinned MSI", { skip: win && process.env.SB_LIBREOFFICE_MSI ? false : "needs Windows and SB_LIBREOFFICE_MSI (Windows CI, T8)", timeout: 1_800_000 }, async () => {
  const dd = tmp("sb-office-loinst-");
  const rt = new OfficeRuntime({ dataDir: dd, runtimeSrc, log: (m) => console.log(m) });
  await rt.installLibreOffice();
  const lo = rt.libreOffice();
  assert.equal(lo.installed, true);
  assert.ok(lo.soffice && fs.existsSync(lo.soffice));
  console.log(`soffice: ${lo.soffice}`);
});
