// Agent Bridge core. Started by the Tauri shell (or by hand for development):
//   node dist/main.js
// Prints one JSON line {"type":"ready","url":...} on stdout when the control UI is up;
// further stdout lines are events for the shell ({"type":"approval",...}). Logs go to stderr.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, dataDir, ConfigSchema, browserToolMode, defaultShell, appsEnabled, DEFAULT_BROWSER_TOOLS, type Config } from "./config.js";
import { openSecrets, ensureGenerated, randomSecret, SECRET_NAMES, type SecretName } from "./secrets.js";
import { Journal } from "./journal.js";
import { Approvals } from "./approvals.js";
import { Gate } from "./gate.js";
import { TerminalPolicy } from "./policies/terminal.js";
import { BrowserPolicy } from "./policies/browser.js";
import { OfficePolicy, type OfficeDetect } from "./policies/office.js";
import { OfficeRuntime } from "./office/runtime.js";
import { Edits } from "./office/edits.js";
import { Supervised } from "./supervisor.js";
import { frpcClientToml, frpcEnv, needsFrpcRestart, placeBundle } from "./frp.js";
import { ControlServer, type Route } from "./control.js";
import { enableAutostart, disableAutostart, autostartStatus, type AutostartStatus } from "./autostart.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const dir = dataDir();
let cfg: Config = loadConfig(dir);
const secrets = await openSecrets(dir);
ensureGenerated(secrets);
const journal = new Journal(dir);
const approvals = new Approvals(() => cfg.approvalTimeoutSec);
let autostart: AutostartStatus = await autostartStatus();
const edits = new Edits(dir);
const runtime = new OfficeRuntime({ dataDir: dir, runtimeSrc: process.env.SB_RUNTIME_SRC ?? path.resolve(here, "..", "runtime"), log });
let officeDetect: OfficeDetect | null = null;
let libreOfficeOffer = false; // the agent needed recalc/render and there is neither Office nor LibreOffice

function resourcesDir(): string {
  return process.env.SB_RESOURCES ?? path.resolve(here, "..", "bin");
}

function frpcPath(): string {
  return process.env.SB_FRPC ?? path.join(resourcesDir(), process.platform === "win32" ? "frpc.exe" : "frpc");
}

function pkgFile(pkg: string, rel: string): string {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel);
}

function workDir(): string {
  const first = cfg.folders.find((f) => fs.existsSync(f));
  return first ?? os.homedir();
}

// ---- gates ----------------------------------------------------------------------------------

type GateKind = "terminal" | "browser" | "apps";
const gates: Partial<Record<GateKind, Gate>> = {};
let officePolicy: OfficePolicy | undefined;

function makeTerminalGate(): Gate {
  const shell = defaultShell(cfg);
  return new Gate({
    name: "terminal",
    port: cfg.terminal.port,
    token: () => secrets.get("gateToken"),
    log,
    child: {
      command: process.execPath,
      args: [pkgFile("@ellery/terminal-mcp", "dist/index.js"), "--headless", "--shell", shell, "--cols", "120", "--rows", "40"],
      env: { NO_UPDATE_NOTIFIER: "1" },
      cwd: workDir(),
    },
    policy: new TerminalPolicy({
      shell,
      folders: () => cfg.folders,
      autoAllow: () => cfg.terminal.autoAllow,
      approvals,
      journal,
    }),
  });
}

function makeBrowserGate(): Gate {
  const outDir = path.join(dir, "browser-output");
  fs.mkdirSync(outDir, { recursive: true });
  const args = [pkgFile("@playwright/mcp", "cli.js"), "--extension", "--output-dir", outDir];
  if (cfg.browser.executablePath) args.push("--executable-path", cfg.browser.executablePath);
  if (cfg.browser.profileDirName) args.push("--profile-dir-name", cfg.browser.profileDirName);
  const ext = secrets.get("extensionToken");
  return new Gate({
    name: "browser",
    port: cfg.browser.port,
    token: () => secrets.get("gateToken"),
    log,
    child: { command: process.execPath, args, env: ext ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: ext } : {}, cwd: outDir },
    policy: new BrowserPolicy({ mode: (t) => browserToolMode(cfg, t), approvals, journal }),
  });
}

// Bridge-native programs (office for now): no child MCP, the policy answers every call itself.
function makeAppsGate(): Gate {
  officePolicy = new OfficePolicy({
    dataDir: dir,
    folders: () => cfg.folders,
    trustScripts: () => cfg.apps.office.trustScripts,
    runtime,
    edits,
    approvals,
    journal,
    onLibreOfficeNeeded: () => {
      if (libreOfficeOffer) return;
      libreOfficeOffer = true;
      control.broadcast("state", {});
    },
  });
  return new Gate({ name: "apps", port: cfg.apps.port, token: () => secrets.get("gateToken"), log, policy: officePolicy });
}

async function detectOffice() {
  if (!officePolicy) return;
  officeDetect = await officePolicy.detect(true).catch((e) => {
    log(`office detect: ${e}`);
    return null;
  });
  control.broadcast("state", {});
}

async function startGate(kind: GateKind) {
  const g = kind === "terminal" ? makeTerminalGate() : kind === "browser" ? makeBrowserGate() : makeAppsGate();
  gates[kind] = g;
  try {
    await g.start();
  } catch (e) {
    g.lastError = String(e);
    log(`gate ${kind} failed to start: ${e}`);
  }
}

async function stopGate(kind: GateKind) {
  const g = gates[kind];
  gates[kind] = undefined;
  await g?.stop().catch(() => {});
}

// ---- frpc -----------------------------------------------------------------------------------

let frpc: Supervised | undefined;
let frpcProblem = "";

async function restartFrpc() {
  await frpc?.stop();
  frpc = undefined;
  const env = frpcEnv(cfg, secrets);
  if ("missing" in env) {
    frpcProblem = `не задан ${(env.missing as string[]).join(", ")}`;
    return;
  }
  if (!fs.existsSync(frpcPath())) {
    frpcProblem = `нет frpc: ${frpcPath()}`;
    return;
  }
  frpcProblem = "";
  const file = path.join(dir, "frpc.toml");
  fs.writeFileSync(file, frpcClientToml(cfg), { mode: 0o600 });
  frpc = new Supervised({ name: "frpc", command: frpcPath(), args: ["-c", file], env });
  frpc.on("change", () => control.broadcast("state", {}));
  frpc.on("log", (l: string) => {
    if (/start proxy success|login to server success|error|failed/i.test(l)) control.broadcast("state", {});
  });
  frpc.start();
}

function frpcStatus() {
  const logs = frpc?.logs.slice(-40) ?? [];
  const proxies = [...new Set(logs.filter((l) => /start proxy success/.test(l)).map((l) => l.match(/\[([^\]]+)\] start proxy success/)?.[1]).filter(Boolean))];
  const lastLogin = [...logs].reverse().find((l) => /login to server success|connect to server error|login to the server failed|authorization failed/i.test(l));
  return {
    state: frpc ? frpc.state : "stopped",
    problem: frpcProblem,
    connected: !!lastLogin && /success/i.test(lastLogin),
    proxies,
    logs,
  };
}

// ---- control API ----------------------------------------------------------------------------

function state() {
  const secretsSet = Object.fromEntries(SECRET_NAMES.map((n) => [n, !!secrets.get(n)]));
  const gate = (g: Gate | undefined, enabled: boolean, port: number) => ({ enabled, port, status: g?.status ?? "down", error: g?.lastError ?? "" });
  return {
    version: (require("../package.json") as { version: string }).version,
    dataDir: dir,
    secretStore: secrets.kind,
    config: cfg,
    defaultBrowserTools: DEFAULT_BROWSER_TOOLS,
    secretsSet,
    gates: {
      terminal: gate(gates.terminal, cfg.terminal.enabled, cfg.terminal.port),
      browser: gate(gates.browser, cfg.browser.enabled, cfg.browser.port),
      apps: gate(gates.apps, appsEnabled(cfg), cfg.apps.port),
    },
    frpc: frpcStatus(),
    approvals: approvals.list(),
    office: { runtime: runtime.status(), detect: officeDetect, libreOffice: { ...runtime.libreOffice(), status: runtime.libreOfficeStatus() }, libreOfficeOffer },
    edits: edits.pending(),
    autostart,
  };
}

async function applyConfig(next: Config) {
  const prev = cfg;
  cfg = ConfigSchema.parse(next);
  saveConfig(cfg, dir);
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const termKey = (c: Config) => ({ ...c.terminal, autoAllow: undefined });
  const browKey = (c: Config) => ({ ...c.browser, tools: undefined });
  if (changed(termKey(prev), termKey(cfg)) || changed(prev.folders[0], cfg.folders[0])) {
    await stopGate("terminal");
    if (cfg.terminal.enabled) await startGate("terminal");
  }
  if (changed(browKey(prev), browKey(cfg))) {
    await stopGate("browser");
    if (cfg.browser.enabled) await startGate("browser");
  }
  if (changed(prev.apps.port, cfg.apps.port) || appsEnabled(prev) !== appsEnabled(cfg)) {
    await stopGate("apps");
    if (appsEnabled(cfg)) await startGate("apps");
  }
  if (cfg.apps.office.enabled && !prev.apps.office.enabled) void runtime.ensure().catch((e) => log(`office runtime: ${e}`));
  if (needsFrpcRestart(prev, cfg)) await restartFrpc();
  journal.add({ gate: "system", action: "config", summary: "настройки сохранены", outcome: "info" });
}

const routes: Route[] = [
  { method: "GET", path: /^\/api\/state$/, handler: () => state() },
  {
    method: "PUT",
    path: /^\/api\/config$/,
    handler: async (_r, body) => {
      await applyConfig(ConfigSchema.parse(body));
      return state();
    },
  },
  {
    method: "PUT",
    path: /^\/api\/secrets$/,
    handler: async (_r, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      let touched = false;
      for (const n of SECRET_NAMES) {
        if (!(n in b)) continue;
        const v = b[n];
        if (v !== null && typeof v !== "string") throw new Error(`bad value for ${n}`);
        secrets.set(n as SecretName, v === "" ? null : (v as string | null));
        touched = true;
      }
      if (b.rotate === "sk" || b.rotate === "gateToken") {
        secrets.set(b.rotate, randomSecret());
        touched = true;
      }
      if (touched) {
        journal.add({ gate: "system", action: "secrets", summary: "секреты изменены", outcome: "info" });
        ensureGenerated(secrets);
        await restartFrpc();
        if ("extensionToken" in b) {
          await stopGate("browser");
          if (cfg.browser.enabled) await startGate("browser");
        }
      }
      return state();
    },
  },
  {
    method: "POST",
    path: /^\/api\/approvals\/([\w-]+)$/,
    handler: (_r, body, m) => {
      const approve = !!(body as { approve?: boolean })?.approve;
      if (!approvals.decide(m[1], approve)) throw new Error("запрос уже закрыт");
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: /^\/api\/edits\/([\w-]+)\/(replace|cancel|open)$/,
    handler: async (_r, body, m) => {
      const rec = edits.get(m[1]);
      if (!rec) throw new Error("правка не найдена");
      if (m[2] === "replace") {
        const force = !!(body as { force?: boolean })?.force;
        const r = await edits.replace(rec.id, { force });
        if (r.result === "replaced")
          journal.add({ gate: "office", action: "replace", summary: `${rec.original} заменён правками агента (бэкап: ${r.backup})`, outcome: "approved" });
        return r;
      }
      if (m[2] === "cancel") {
        const r = await edits.cancel(rec.id);
        if (r.ok) journal.add({ gate: "office", action: "cancel", summary: `правки отменены: ${rec.copy}`, outcome: "denied" });
        return r;
      }
      openWithDefaultApp(rec.copy);
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: /^\/api\/office\/libreoffice$/,
    handler: async (_r, body) => {
      libreOfficeOffer = false;
      if ((body as { install?: boolean })?.install) {
        journal.add({ gate: "office", action: "libreoffice", summary: "клиент согласился скачать LibreOffice", outcome: "approved" });
        void runtime
          .installLibreOffice()
          .then(() => detectOffice())
          .catch((e) => log(`libreoffice: ${e}`));
      } else journal.add({ gate: "office", action: "libreoffice", summary: "LibreOffice — не сейчас", outcome: "denied" });
      return state();
    },
  },
  { method: "GET", path: /^\/api\/journal$/, handler: () => journal.tail(300) },
  { method: "GET", path: /^\/api\/place-bundle$/, handler: () => placeBundle(cfg, secrets) },
  {
    method: "PUT",
    path: /^\/api\/autostart$/,
    handler: async (_r, body) => {
      const on = !!(body as { enabled?: boolean })?.enabled;
      const exe = process.env.SB_APP_EXE;
      if (on && !exe) throw new Error("путь к приложению неизвестен (запуск не из оболочки)");
      autostart = on ? await enableAutostart(exe!, dir) : await disableAutostart();
      return state();
    },
  },
];

const control = new ControlServer(routes, path.join(here, "ui"));
approvals.on("pending", (req) => emit({ type: "approval", id: req.id, gate: req.gate, title: req.title }));
approvals.on("change", () => control.broadcast("approvals", approvals.list()));
journal.on("entry", (e) => control.broadcast("journal", e));
edits.on("change", () => control.broadcast("state", {}));
runtime.on("change", () => {
  if (runtime.status().state === "ready" && !officeDetect) void detectOffice();
  control.broadcast("state", {});
});

// «Открыть копию»: the user's own default program for the file; only registered copies get here.
function openWithDefaultApp(file: string) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", (e) => log(`open ${file}: ${e}`)).unref();
}

// ---- start ----------------------------------------------------------------------------------

const port = await control.start(Number(process.env.SB_CONTROL_PORT ?? cfg.control.port));
if (cfg.terminal.enabled) await startGate("terminal");
if (cfg.browser.enabled) await startGate("browser");
if (appsEnabled(cfg)) await startGate("apps");
if (cfg.apps.office.enabled) void runtime.ensure().catch((e) => log(`office runtime: ${e}`));
await restartFrpc();
edits.purgeBackups();
setInterval(() => edits.purgeBackups(), 24 * 3600_000).unref();

// First start from the installed app: register autostart once (the user can switch it off).
const marker = path.join(dir, ".autostart-initialized");
if (process.env.SB_APP_EXE && process.platform === "win32" && !fs.existsSync(marker)) {
  try {
    autostart = await enableAutostart(process.env.SB_APP_EXE, dir);
  } catch (e) {
    log(`autostart: ${e}`);
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

journal.add({ gate: "system", action: "start", summary: `мост запущен (${cfg.clientId})`, outcome: "info" });
emit({ type: "ready", url: `http://127.0.0.1:${port}/#t=${control.token}`, port });
log(`control UI on 127.0.0.1:${port}, data ${dir}, secrets in ${secrets.kind} store`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  approvals.denyAll();
  journal.add({ gate: "system", action: "stop", summary: "мост остановлен", outcome: "info" });
  await Promise.allSettled([stopGate("terminal"), stopGate("browser"), stopGate("apps"), frpc?.stop(), control.stop()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Started by the Tauri shell: it holds our stdin open and closes it when it exits.
if (process.env.SB_STDIN_LIFELINE === "1") {
  process.stdin.on("end", () => void shutdown());
  process.stdin.resume();
}
