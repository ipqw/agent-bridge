// Integration: a gate without a child MCP (bridge-native tools), driven over HTTP like the agent does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Gate, type CallContext, type ChildHandle, type Policy, type Verdict } from "../src/gate.ts";

const PORT = 46000 + Math.floor(Math.random() * 900);
const TOKEN = "test-token-nochild";
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

const TOOLS: Tool[] = [
  { name: "office_echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "office_forward", description: "asks the gate to forward", inputSchema: { type: "object" } },
  { name: "office_wait", description: "waits until the agent drops the call", inputSchema: { type: "object" } },
];

const seen = { childTools: [] as Tool[][], signals: [] as AbortSignal[], childCall: "" };
// Resolves when office_wait is inside decide; then resolves again with whether its signal aborted.
let entered: () => void = () => {};
let observed: (aborted: boolean) => void = () => {};

class FakePolicy implements Policy {
  instructions = "test gate without a child";
  tools(childTools: Tool[]): Tool[] {
    seen.childTools.push(childTools);
    return TOOLS;
  }
  async decide(name: string, args: Record<string, unknown>, child: ChildHandle, ctx?: CallContext): Promise<Verdict> {
    if (ctx) seen.signals.push(ctx.signal);
    if (name === "office_echo") {
      await child.call("anything", {}).catch((e) => (seen.childCall = String(e)));
      return { action: "result", result: { content: [{ type: "text", text: `echo:${args.text}` }] } };
    }
    if (name === "office_wait") {
      entered();
      const aborted = await new Promise<boolean>((resolve) => {
        if (!ctx) return resolve(false);
        const t = setTimeout(() => resolve(false), 5000); // never hang the suite
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      observed(aborted);
      return { action: "result", result: { content: [{ type: "text", text: "done" }] } };
    }
    return { action: "forward" };
  }
}

const gate = new Gate({ name: "apps", port: PORT, token: () => TOKEN, policy: new FakePolicy() });
let client: Client;

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

before(async () => {
  await gate.start();
  client = new Client({ name: "agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

after(async () => {
  await client.close().catch(() => {});
  await gate.stop();
});

test("no child: gate is up and tools/list is exactly policy.tools([])", async () => {
  // protects=bridge-native tools are visible without a child process; fails_when=the gate waits for or lists a child; no_claim=no process is spawned (not observed directly)
  assert.equal(gate.status, "up");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(seen.childTools.length > 0 && seen.childTools.every((c) => c.length === 0), "policy.tools got []");
});

test("no child: the policy answers the call; forward is an error, not a crash", async () => {
  // protects=calls are decided entirely by the policy and a stray forward fails safely; fails_when=the gate tries to reach a child or hangs on forward; no_claim=the wording of the error
  const r = (await client.callTool({ name: "office_echo", arguments: { text: "привет" } })) as CallToolResult;
  assert.notEqual(r.isError, true, text(r));
  assert.equal(text(r), "echo:привет");
  assert.match(seen.childCall, /no child/, "the child handle refuses instead of pretending");
  const f = (await client.callTool({ name: "office_forward", arguments: {} })) as CallToolResult;
  assert.equal(f.isError, true);
  assert.match(text(f), /office_forward/);
  assert.match(text(f), /нет локального MCP/);
  assert.ok(seen.signals.length >= 2 && seen.signals.every((s) => s instanceof AbortSignal), "decide gets ctx.signal");
});

test("ctx.signal aborts when the agent drops the HTTP request", { timeout: 15000 }, async () => {
  // protects=a long policy action (script run) learns the agent hung up and can kill its work; fails_when=extra.signal is not passed or the gate does not close the transport on disconnect; no_claim=child-backed gates or what the policy does on abort
  const inside = new Promise<void>((r) => (entered = r));
  const result = new Promise<boolean>((r) => (observed = r));
  const ac = new AbortController();
  const req = fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "office_wait", arguments: {} } }),
    signal: ac.signal,
  });
  req.catch(() => {}); // rejected by the abort below
  await Promise.race([inside, req.then(async (r) => assert.fail(`answered before abort: ${r.status} ${await r.text()}`))]);
  ac.abort();
  assert.equal(await result, true, "policy saw the abort");
  // the gate keeps serving after a dropped call
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOLS.length);
});
