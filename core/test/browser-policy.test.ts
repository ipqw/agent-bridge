import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { BrowserPolicy } from "../src/policies/browser.ts";
import { Approvals } from "../src/approvals.ts";
import { Journal } from "../src/journal.ts";
import { browserToolMode, ConfigSchema } from "../src/config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-br-"));
const cfg = ConfigSchema.parse({ clientId: "test-client", browser: { tools: { browser_click: "auto", browser_snapshot: "deny" } } });
const approvals = new Approvals(() => 1);
const asked: string[] = [];
approvals.on("pending", (r) => {
  asked.push(r.title);
  approvals.decide(r.id, false);
});
const policy = new BrowserPolicy({ mode: (t) => browserToolMode(cfg, t), approvals, journal: new Journal(tmp) });

test("modes: defaults, overrides, unknown tools ask", () => {
  assert.equal(browserToolMode(cfg, "browser_navigate"), "auto");
  assert.equal(browserToolMode(cfg, "browser_click"), "auto"); // user override
  assert.equal(browserToolMode(cfg, "browser_snapshot"), "deny"); // user override
  assert.equal(browserToolMode(cfg, "browser_file_upload"), "ask");
  assert.equal(browserToolMode(cfg, "browser_something_new"), "ask");
});

test("denied tools are hidden from the agent", () => {
  const tools = policy.tools([{ name: "browser_snapshot", inputSchema: { type: "object" } }, { name: "browser_navigate", inputSchema: { type: "object" } }]);
  assert.deepEqual(tools.map((t) => t.name), ["browser_navigate"]);
});

test("http(s) navigation runs; file:/chrome:/javascript: ask", async () => {
  assert.equal((await policy.decide("browser_navigate", { url: "https://example.com" })).action, "forward");
  for (const url of ["file:///C:/Users/u/.ssh/id_rsa", "chrome://settings", "javascript:alert(1)", "data:text/html,x"]) {
    const v = await policy.decide("browser_navigate", { url });
    assert.equal(v.action, "result", url);
  }
  assert.equal(asked.length, 4);
});

test("ask-mode tool refused by the user returns an error to the agent", async () => {
  const v = await policy.decide("browser_file_upload", { paths: ["C:\\x"] });
  assert.equal(v.action, "result");
  assert.equal(v.action === "result" && v.result.isError, true);
});

test("arbitrary-code tool is off by default", () => {
  const fresh = ConfigSchema.parse({ clientId: "test-client" });
  assert.equal(browserToolMode(fresh, "browser_run_code_unsafe"), "deny");
});
