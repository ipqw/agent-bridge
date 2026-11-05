// Integration: agent -> stcp visitor -> frps -> frpc (client) -> gate -> terminal-mcp, all on loopback.
// Requires frp binaries: node ../scripts/fetch-frp.mjs .cache/frp  (or SB_FRP_DIR)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gate } from "../src/gate.ts";
import { TerminalPolicy } from "../src/policies/terminal.ts";
import { Approvals } from "../src/approvals.ts";
import { Journal } from "../src/journal.ts";
import { Supervised } from "../src/supervisor.ts";
import { ConfigSchema } from "../src/config.ts";
import { frpcClientToml, frpcEnv, placeBundle } from "../src/frp.ts";
import type { Secrets } from "../src/secrets.ts";

const require = createRequire(import.meta.url);
const exe = process.platform === "win32" ? ".exe" : "";
const frpDir = process.env.SB_FRP_DIR ?? path.resolve(".cache/frp");
const haveFrp = fs.existsSync(path.join(frpDir, `frpc${exe}`));

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sb-frp-")));
const home = path.join(tmp, "home");
const docs = path.join(tmp, "docs");
fs.mkdirSync(home);
fs.mkdirSync(docs);
fs.writeFileSync(path.join(home, ".bashrc"), "PS1='$PWD\\$ '\n");
fs.writeFileSync(path.join(docs, "a.txt"), "via-tunnel\n");

const rnd = () => 20000 + Math.floor(Math.random() * 20000);
const FRPS_PORT = rnd();
const GATE_PORT = rnd();
const VISITOR_BASE = rnd();
const shell = process.platform === "win32" ? "powershell.exe" : "bash";

const store: Record<string, string> = { frpsToken: "frps-secret", sk: "stcp-secret", gateToken: "gate-secret" };
const secrets = { kind: "mem", get: (n: string) => store[n] ?? null, set: (n: string, v: string | null) => (v === null ? delete store[n] : (store[n] = v)) } as unknown as Secrets;
const cfg = ConfigSchema.parse({
  clientId: "test-client",
  frps: { addr: "127.0.0.1", port: FRPS_PORT },
  folders: [docs],
  terminal: { port: GATE_PORT },
  browser: { enabled: false },
});

const approvals = new Approvals(() => 3);
const journal = new Journal(tmp);
const gate = new Gate({
  name: "terminal",
  port: GATE_PORT,
  token: () => store.gateToken,
  child: {
    command: process.execPath,
    args: [path.join(path.dirname(require.resolve("@ellery/terminal-mcp/package.json")), "dist/index.js"), "--headless", "--shell", shell],
    env: { HOME: home, NO_UPDATE_NOTIFIER: "1" },
    cwd: docs,
  },
  policy: new TerminalPolicy({ shell, folders: () => [docs], autoAllow: () => true, approvals, journal }),
});

const procs: Supervised[] = [];
function spawnFrp(bin: "frps" | "frpc", toml: string, file: string, env: Record<string, string> = {}) {
  fs.writeFileSync(path.join(tmp, file), toml, { mode: 0o600 });
  const p = new Supervised({ name: file, command: path.join(frpDir, bin + exe), args: ["-c", path.join(tmp, file)], env });
  p.start();
  procs.push(p);
  return p;
}

async function waitFor(p: Supervised, re: RegExp, ms = 15000, from = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (p.logs.slice(from).some((l) => re.test(l))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${re} in:\n${p.logs.join("\n")}`);
}

async function connect(port: number, token = store.gateToken) {
  const c = new Client({ name: "agent", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

let frpcClient: Supervised;
let visitorPort = 0;

before(async () => {
  if (!haveFrp) return;
  await gate.start();
  const frps = spawnFrp("frps", `bindAddr = "127.0.0.1"\nbindPort = ${FRPS_PORT}\nauth.method = "token"\nauth.token = "${store.frpsToken}"\n`, "frps.toml");
  await waitFor(frps, /frps started successfully/);
  const env = frpcEnv(cfg, secrets) as Record<string, string>;
  frpcClient = spawnFrp("frpc", frpcClientToml(cfg), "frpc-client.toml", env);
  await waitFor(frpcClient, /\[terminal\] start proxy success/);
  const bundle = placeBundle(cfg, secrets, VISITOR_BASE);
  visitorPort = JSON.parse(bundle.mcpJson).mcpServers["bridge-terminal"].url.match(/:(\d+)\//)[1] * 1;
  const visitor = spawnFrp("frpc", bundle.visitorToml, "frpc-visitor.toml");
  await waitFor(visitor, /start visitor success/);
  // wrong-key visitor on the next port
  spawnFrp("frpc", bundle.visitorToml.replace(store.sk, "wrong-key").replace(`bindPort = ${VISITOR_BASE}`, `bindPort = ${VISITOR_BASE + 50}`).replaceAll("-visitor", "-badvisitor"), "frpc-bad.toml");
  await new Promise((r) => setTimeout(r, 1500));
});

after(async () => {
  for (const p of procs) await p.stop();
  await gate.stop().catch(() => {});
  // Windows: the shell may hold its cwd for a moment after the terminal is closed
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* temp dir; leftover is harmless */
  }
});

test("frp binaries present", { skip: haveFrp ? false : "run scripts/fetch-frp.mjs" }, () => assert.ok(haveFrp));

test("agent on the place reaches the terminal through stcp and reads an allowed file", { skip: !haveFrp }, async () => {
  const c = await connect(visitorPort);
  const { tools } = await c.listTools();
  assert.ok(tools.some((t) => t.name === "type"));
  // wait for the prompt
  const prompt = process.platform === "win32" ? "> " : "$ ";
  for (let i = 0; i < 100 && !text((await c.callTool({ name: "getContent", arguments: {} })) as CallToolResult).includes(prompt); i++) await new Promise((r) => setTimeout(r, 200));
  await c.callTool({ name: "type", arguments: { text: "cat a.txt" } });
  const r = (await c.callTool({ name: "sendKey", arguments: { key: "Enter" } })) as CallToolResult;
  assert.notEqual(r.isError, true, text(r));
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    seen = text((await c.callTool({ name: "getContent", arguments: {} })) as CallToolResult).includes("via-tunnel");
    if (!seen) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(seen);
  await c.close();
});

test("wrong stcp key cannot reach the gate", { skip: !haveFrp }, async () => {
  await assert.rejects(connect(VISITOR_BASE + 50), "connection through a visitor with a wrong sk must fail");
});

test("wrong gate token through a valid tunnel is refused", { skip: !haveFrp }, async () => {
  await assert.rejects(connect(visitorPort, "nope"));
});

test("client tunnel down => place sees MCP unavailable; back up => reconnects", { skip: !haveFrp }, async () => {
  await frpcClient.stop();
  await new Promise((r) => setTimeout(r, 1000));
  await assert.rejects(connect(visitorPort));
  const mark = frpcClient.logs.length;
  frpcClient.start();
  await waitFor(frpcClient, /\[terminal\] start proxy success/, 15000, mark);
  const c = await connect(visitorPort);
  assert.ok((await c.listTools()).tools.length > 0);
  await c.close();
});
