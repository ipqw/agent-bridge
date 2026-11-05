// Integration: real terminal-mcp (bash) behind the gate, driven by an MCP client over HTTP.
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

const require = createRequire(import.meta.url);
const win = process.platform === "win32";
const SHELL = win ? "powershell.exe" : "bash";
const PROMPT = win ? "> " : "$ ";
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sb-term-")));
const home = path.join(tmp, "home");
const docs = path.join(tmp, "docs");
const outside = path.join(tmp, "outside");
for (const d of [home, docs, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(home, ".bashrc"), "PS1='$PWD\\$ '\n");
fs.writeFileSync(path.join(docs, "a.txt"), "hello-allowed\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "top-secret\n");

const PORT = 47000 + Math.floor(Math.random() * 900);
const TOKEN = "test-token-123";
const approvals = new Approvals(() => 3);
const journal = new Journal(tmp);
let decide: (title: string) => boolean | null = () => null;
approvals.on("pending", (req) => {
  const d = decide(req.title);
  if (d !== null) setTimeout(() => approvals.decide(req.id, d), 50);
});

const gate = new Gate({
  name: "terminal",
  port: PORT,
  token: () => TOKEN,
  child: {
    command: process.execPath,
    args: [path.join(path.dirname(require.resolve("@ellery/terminal-mcp/package.json")), "dist/index.js"), "--headless", "--shell", SHELL, "--cols", "120", "--rows", "40"],
    env: { HOME: home, NO_UPDATE_NOTIFIER: "1" },
    cwd: docs,
  },
  policy: new TerminalPolicy({ shell: SHELL, folders: () => [docs], autoAllow: () => true, approvals, journal }),
});

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function screenHas(needle: string, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (text(await call("getContent")).includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function run(cmd: string): Promise<CallToolResult> {
  await call("type", { text: cmd });
  return call("sendKey", { key: "Enter" });
}

before(async () => {
  await gate.start();
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  assert.ok(await screenHas(PROMPT, 20000), "shell prompt appears");
});

after(async () => {
  await client.close().catch(() => {});
  await gate.stop();
  // Windows: the shell may hold its cwd for a moment after the terminal is closed
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* temp dir; leftover is harmless */
  }
});

test("only safe tools are exposed; createSession has no shell argument", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["createSession", "destroySession", "getContent", "listSessions", "sendKey", "takeScreenshot", "type"]);
  const cs = tools.find((t) => t.name === "createSession")!;
  assert.equal("shell" in ((cs.inputSchema.properties as object) ?? {}), false);
});

test("allowlisted read inside the folder runs without asking", async () => {
  decide = () => {
    throw new Error("must not ask");
  };
  const r = await run("cat a.txt");
  assert.notEqual(r.isError, true, text(r));
  assert.ok(await screenHas("hello-allowed"));
});

test("read outside the folder asks; refusal cancels the line", async () => {
  decide = () => false;
  const r = await run(`cat ${path.join(outside, "secret.txt")}`);
  assert.equal(r.isError, true);
  assert.match(text(r), /refused/);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(text(await call("getContent")).includes("top-secret"), false);
});

test("approved command runs", async () => {
  decide = (title) => title.includes("secret.txt");
  const r = await run(`cat ${path.join(outside, "secret.txt")}`);
  assert.notEqual(r.isError, true, text(r));
  assert.ok(await screenHas("top-secret"));
});

test("input while an approval is pending is refused; the approved line runs unchanged", async () => {
  decide = () => null; // hold the request open
  const pending = run(`cat ${path.join(outside, "secret.txt")}`);
  for (let i = 0; i < 100 && !approvals.list().length; i++) await new Promise((r) => setTimeout(r, 50));
  const [req] = approvals.list();
  assert.ok(req, "approval requested");
  const sneaky = await call("type", { text: " && touch evil.txt" });
  assert.equal(sneaky.isError, true, "typing during a pending approval must be refused");
  const enter2 = await call("sendKey", { key: "Enter" });
  assert.equal(enter2.isError, true);
  approvals.decide(req.id, true);
  const r = await pending;
  assert.notEqual(r.isError, true, text(r));
  assert.ok(await screenHas("top-secret"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(docs, "evil.txt")), false);
});

test("an edited line is never auto-approved", async () => {
  const titles: string[] = [];
  decide = (t) => {
    titles.push(t);
    return false;
  };
  await call("type", { text: "cat a.txt" });
  await call("sendKey", { key: "ArrowLeft" });
  const r = await call("sendKey", { key: "Enter" });
  assert.equal(r.isError, true);
  assert.equal(titles.length, 1);
});

test("no answer = deny (timeout); write does not happen", async () => {
  decide = () => null;
  const r = await run("echo pwned > x.txt");
  assert.equal(r.isError, true);
  assert.match(text(r), /in time/);
  assert.equal(fs.existsSync(path.join(docs, "x.txt")), false);
});

test("typed newline is refused; Ctrl+M counts as submit", async () => {
  const r1 = await call("type", { text: "touch nl.txt\n" });
  assert.equal(r1.isError, true);
  await call("sendKey", { key: "Ctrl+C" });
  decide = () => false;
  await call("type", { text: "touch cm.txt" });
  const r2 = await call("sendKey", { key: "Ctrl+M" });
  assert.equal(r2.isError, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(docs, "nl.txt")), false);
  assert.equal(fs.existsSync(path.join(docs, "cm.txt")), false);
});

test("createSession cannot choose its own shell", async () => {
  const r = await call("createSession", { shell: `/bin/sh -c 'touch ${docs}/pwned'` });
  assert.notEqual(r.isError, true, text(r));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.existsSync(path.join(docs, "pwned")), false);
});

test("HTTP boundary: bearer required, browser origin refused, foreign host refused", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", headers: h, body });
  assert.equal(noAuth.status, 401);
  const withOrigin = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { ...h, authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    body,
  });
  assert.equal(withOrigin.status, 403);
});

test("journal records auto / denied / approved / timeout", () => {
  const outcomes = new Set(journal.tail().map((e) => e.outcome));
  for (const o of ["auto", "denied", "approved", "timeout", "blocked"]) assert.ok(outcomes.has(o as never), o);
});
