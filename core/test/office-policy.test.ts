// Integration: the apps gate with the office policy (T6), driven over HTTP like the agent does, on the
// pinned runtime the client gets (core/.cache/test-office-runtime, shared with the other office tests).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gate } from "../src/gate.ts";
import { Approvals } from "../src/approvals.ts";
import { Journal } from "../src/journal.ts";
import { OfficeRuntime } from "../src/office/runtime.ts";
import { Edits } from "../src/office/edits.ts";
import { OfficePolicy, OFFICE_TOOLS } from "../src/policies/office.ts";

const win = process.platform === "win32";
const supported = (win || process.platform === "linux") && process.arch === "x64";
const skip = supported ? false : "office runtime is pinned for windows/linux x64 only";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sb-office-policy-")));
const data = path.join(tmp, "data");
const docs = path.join(tmp, "docs");
const outside = path.join(tmp, "outside");
for (const d of [data, docs, outside]) fs.mkdirSync(d);

const PORT = 45000 + Math.floor(Math.random() * 900);
const TOKEN = "test-token-office";
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

const rt = new OfficeRuntime({ dataDir: path.resolve(".cache/test-office-runtime"), runtimeSrc: path.resolve("runtime") });
const edits = new Edits(data);
const approvals = new Approvals(() => 5);
const journal = new Journal(data);
let trust = false;
let loNeeded = 0;
let decide: (title: string, details: string) => boolean | null = () => null;
const asked: string[] = [];
approvals.on("pending", (req) => {
  asked.push(req.title);
  const d = decide(req.title, req.details);
  if (d !== null) setTimeout(() => approvals.decide(req.id, d), 30);
});

const policy = new OfficePolicy({
  dataDir: data,
  folders: () => [docs],
  trustScripts: () => trust,
  runtime: rt,
  edits,
  approvals,
  journal,
  onLibreOfficeNeeded: () => loNeeded++,
  runTimeoutMs: 8000,
});
const gate = new Gate({ name: "apps", port: PORT, token: () => TOKEN, policy });
let client: Client;

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const journalHas = (action: string, outcome: string, re: RegExp) =>
  journal.tail(500).some((e) => e.gate === "office" && e.action === action && e.outcome === outcome && re.test(e.summary));
function fixture(kind: string, out: string) {
  execFileSync(rt.python(), ["-I", path.resolve("test/office-fixtures.py"), kind, out], { stdio: ["ignore", "ignore", "inherit"] });
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (p: string) => JSON.stringify(p); // a path as a Python string literal

before(async () => {
  await gate.start();
  client = new Client({ name: "agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  if (!supported) return;
  await rt.ensure();
  assert.equal(rt.status().state, "ready", rt.status().message);
  fixture("xlsx", path.join(docs, "Отчёт.xlsx"));
  fixture("docx", path.join(docs, "Письмо.docx"));
  fixture("docx", path.join(outside, "Чужое.docx"));
});

after(async () => {
  await client.close().catch(() => {});
  await gate.stop();
  rt.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("apps gate lists exactly the office tools, no Node tool (D1)", async () => {
  // protects=the agent sees the batch-1 surface; fails_when=a tool is missing or office_run_node sneaks in; no_claim=tool descriptions' wording
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), OFFICE_TOOLS.map((t) => t.name).sort());
  assert.ok(!tools.some((t) => t.name === "office_run_node"));
});

test("office_read inside the folders: text without a card (AC2)", { skip, timeout: 120_000 }, async () => {
  // protects=reading in allowed folders is automatic; fails_when=a card is raised or markitdown output is lost; no_claim=paging (separate test)
  asked.length = 0;
  const r = await call("office_read", { path: path.join(docs, "Письмо.docx") });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /DOCX-MARKER/);
  assert.equal(asked.length, 0);
  assert.ok(journalHas("office_read", "auto", /Письмо\.docx/));
});

test("office_read outside the folders: card; refuse → error, file not read, journal denied (AC2)", { skip, timeout: 60_000 }, async () => {
  // protects=nothing outside the allowed folders is read without the user; fails_when=no card, or the file is read before/without approval; no_claim=what the card looks like in the window
  decide = () => false;
  const r = await call("office_read", { path: path.join(outside, "Чужое.docx") });
  assert.equal(r.isError, true);
  assert.match(text(r), /refused/);
  assert.doesNotMatch(text(r), /DOCX-MARKER/);
  assert.ok(asked.some((t) => t.includes("Чужое.docx")));
  assert.ok(journal.tail(500).some((e) => e.action === "office_read" && e.outcome === "denied"));
  decide = () => true;
  const ok = await call("office_read", { path: path.join(outside, "Чужое.docx") });
  assert.match(text(ok), /DOCX-MARKER/, "approved once → read");
  decide = () => null;
});

test("office_read pages long text by offset; .doc/.ppt → «сначала office_convert» (R10)", { skip, timeout: 120_000 }, async () => {
  // protects=answers stay ≤ 64 KB and the agent can continue; legacy formats fail honestly; fails_when=the cap or the offset hint is dropped, or .doc returns empty text; no_claim=.xls (LibreOffice-backed tests)
  const big = path.join(docs, "Большой.docx");
  execFileSync(rt.python(), ["-I", "-c", `from docx import Document\nd=Document()\nfor i in range(4000): d.add_paragraph(f"строка {i:05d} " + "текст "*8)\nd.save(${q(big)})`]);
  const first = text(await call("office_read", { path: big }));
  assert.ok(Buffer.byteLength(first) <= 64 * 1024 + 200, `first page ${Buffer.byteLength(first)} bytes`);
  const next = Number(first.match(/continue with offset=(\d+)/)?.[1]);
  assert.ok(next > 0, "offset hint present");
  const second = text(await call("office_read", { path: big, offset: next }));
  assert.ok(!second.startsWith(first.slice(0, 50)), "second page is a different slice");
  fs.writeFileSync(path.join(docs, "Старый.doc"), "not really a doc");
  const legacy = await call("office_read", { path: path.join(docs, "Старый.doc") });
  assert.equal(legacy.isError, true);
  assert.match(text(legacy), /office_convert/);
});

test("copy → in-pool script edits the copy without a card; original untouched (AC3, AC4)", { skip, timeout: 120_000 }, async () => {
  // protects=the everyday path: copy, openpyxl edit inside the pool, no card; fails_when=the guard blocks a legit edit, or the original changes; no_claim=Windows hook events (Windows CI)
  asked.length = 0;
  const orig = path.join(docs, "Отчёт.xlsx");
  const before = fs.readFileSync(orig);
  const c = text(await call("office_copy", { path: orig }));
  const copy = c.match(/Working copy: (.*)/)?.[1] ?? "";
  assert.equal(copy, path.join(docs, "Отчёт (правки агента).xlsx"));
  const r = await call("office_run_python", {
    cwd: docs,
    script: `from openpyxl import load_workbook\nwb = load_workbook(${q(copy)})\nwb.active["C1"] = "правка агента"\nwb.save(${q(copy)})\nprint("ok")`,
  });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /ok/);
  assert.equal(asked.length, 0, "no card in the pool");
  assert.deepEqual(fs.readFileSync(orig), before, "original untouched");
  assert.ok(journalHas("office_run_python", "auto", /в пуле: выполнен/));
});

test("in-pool script that writes the original is stopped by the guard (AC4)", { skip, timeout: 60_000 }, async () => {
  // protects=the original never changes through a script; fails_when=write_files includes originals or the hook misses it; no_claim=C-level writes (accepted risk D3)
  const orig = path.join(docs, "Отчёт.xlsx");
  const before = fs.readFileSync(orig);
  const r = await call("office_run_python", { cwd: docs, script: `open(${q(orig)}, "wb").write(b"x")` });
  assert.equal(r.isError, true);
  assert.match(text(r), /pool stopped the script/);
  assert.deepEqual(fs.readFileSync(orig), before);
  assert.ok(journalHas("office_run_python", "blocked", /остановлен сторожем/));
});

test("script outside the pool: card with a plain reason; refused → not run, journal denied (D7)", { skip, timeout: 60_000 }, async () => {
  // protects=out-of-pool code never runs without the user; fails_when=the card is skipped or the script runs after a refusal; no_claim=the window's rendering of the card
  const marker = path.join(docs, "отказ.txt");
  let card = "";
  decide = (title, details) => {
    card = `${title}\n${details}`;
    return false;
  };
  const r = await call("office_run_python", { cwd: docs, script: `import os\nopen(${q(marker)}, "w").write(os.getcwd())` });
  assert.equal(r.isError, true);
  assert.match(text(r), /refused/);
  assert.ok(!fs.existsSync(marker), "not executed");
  assert.match(card.split("\n")[0], /Скрипт агента хочет/, "reason in plain words first");
  assert.match(card, /import os/, "code is in the details");
  assert.ok(journal.tail(500).some((e) => e.action === "office_run_python" && e.outcome === "denied"));
  decide = () => null;
});

test("script outside the pool: approved → runs without the guard (import os works) (D7)", { skip, timeout: 60_000 }, async () => {
  // protects=«Разрешить» actually allows what was asked; fails_when=the hook stays on after approval; no_claim=approved scripts' side effects are not registered as agent files
  const marker = path.join(docs, "разрешено.txt");
  decide = () => true;
  const r = await call("office_run_python", { cwd: docs, script: `import os\nopen(${q(marker)}, "w").write(os.getcwd())\nprint("ran")` });
  decide = () => null;
  assert.notEqual(r.isError, true, text(r));
  assert.equal(fs.readFileSync(marker, "utf8"), docs);
  assert.ok(journal.tail(500).some((e) => e.action === "office_run_python" && e.outcome === "approved" && /без проверки/.test(e.summary)));
});

test("trustScripts: out-of-pool script runs without a card", { skip, timeout: 60_000 }, async () => {
  // protects=the user's switch means «all scripts approved»; fails_when=a card still appears or the script is refused; no_claim=the red mark in the window (UI)
  trust = true;
  asked.length = 0;
  const r = await call("office_run_python", { cwd: docs, script: `import os\nprint(os.getcwd())` });
  trust = false;
  assert.notEqual(r.isError, true, text(r));
  assert.equal(asked.length, 0);
  assert.ok(journal.tail(500).some((e) => e.action === "office_run_python" && e.reason?.startsWith("trustScripts")));
});

test("cwd outside the folders is refused; output capped at 64 KB; timeout kills the run", { skip, timeout: 90_000 }, async () => {
  // protects=run limits from the spec (cwd, output, time); fails_when=any limit is dropped; no_claim=the exact 120 s value (tests use 8 s)
  const bad = await call("office_run_python", { cwd: outside, script: `print(1)` });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /cwd must be inside/);
  const loud = text(await call("office_run_python", { cwd: docs, script: `print("я" * 200000)` }));
  assert.ok(Buffer.byteLength(loud) < 70 * 1024, `output ${Buffer.byteLength(loud)} bytes`);
  assert.match(loud, /truncated/);
  const t0 = Date.now();
  const slow = await call("office_run_python", { cwd: docs, script: `while True:\n    pass` });
  assert.equal(slow.isError, true);
  assert.match(text(slow), /stopped/);
  assert.ok(Date.now() - t0 < 30_000);
});

test("agent drops the call → script process killed; a second run meanwhile is «ещё идёт» (R8)", { skip, timeout: 90_000 }, async () => {
  // protects=no orphaned writer after a disconnect and no concurrent runs; fails_when=the abort signal is not wired to the process tree or the run lock is missing; no_claim=frp-level disconnect timing (local HTTP abort only)
  const beat = path.join(docs, "пульс.txt");
  const ac = new AbortController();
  const req = fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "office_run_python", arguments: { cwd: docs, script: `f = open(${q(beat)}, "a")\nwhile True:\n    f.write("x"); f.flush()\n    s = sum(range(300000))` } },
    }),
    signal: ac.signal,
  });
  req.catch(() => {});
  for (let i = 0; i < 200 && !(fs.existsSync(beat) && fs.statSync(beat).size > 0); i++) await sleep(50);
  assert.ok(fs.existsSync(beat), "script started");
  const busy = await call("office_run_python", { cwd: docs, script: "print(1)" });
  assert.equal(busy.isError, true);
  assert.match(text(busy), /предыдущий запуск ещё идёт/);
  ac.abort();
  await sleep(1500);
  const size = fs.statSync(beat).size;
  await sleep(800);
  assert.equal(fs.statSync(beat).size, size, "the script no longer writes");
  assert.ok(journalHas("office_run_python", "error", /оборвал связь/));
  const after = await call("office_run_python", { cwd: docs, script: "print('free')" });
  assert.match(text(after), /free/, "the run lock is released");
});

test("files a script creates are registered: next run edits without a card; recalc/render allowed (R9)", { skip, timeout: 120_000 }, async () => {
  // protects=the agent's own new files are workable without review; fails_when=the manifest is not read or not registered; no_claim=files created by approved (unguarded) scripts
  asked.length = 0;
  const pdf = path.join(docs, "Новый отчёт.pdf");
  const r1 = await call("office_run_python", {
    cwd: docs,
    script: `from reportlab.pdfgen import canvas\nc = canvas.Canvas(${q(pdf)})\nc.drawString(100, 750, "NEW-PDF")\nc.showPage()\nc.save()`,
  });
  assert.notEqual(r1.isError, true, text(r1));
  assert.match(text(r1), /New files/);
  assert.ok(edits.isAgentEditable(pdf));
  const r2 = await call("office_run_python", { cwd: docs, script: `open(${q(pdf)}, "rb").read()\nprint("reopened")` });
  assert.match(text(r2), /reopened/);
  const img = await call("office_render", { path: pdf });
  assert.notEqual(img.isError, true, text(img));
  const png = img.content.find((c) => c.type === "image");
  assert.ok(png && png.type === "image" && png.mimeType === "image/png" && png.data.length > 100);
  assert.equal(asked.length, 0);
  const propose = await call("office_propose", { path: pdf, summary: "новый файл" });
  assert.equal(propose.isError, true);
  assert.match(text(propose), /need no review/);
});

test("recalc/render refuse the client's own files (only copies and agent files)", { skip, timeout: 60_000 }, async () => {
  // protects=automation never opens the client's original for writing; fails_when=the copy/agent-file check is dropped; no_claim=none beyond protects
  const r = await call("office_recalc", { path: path.join(docs, "Отчёт.xlsx") });
  assert.equal(r.isError, true);
  assert.match(text(r), /only on working copies/);
  const v = await call("office_render", { path: path.join(docs, "Письмо.docx") });
  assert.equal(v.isError, true);
});

test("no Office and no LibreOffice: recalc → clear error to the agent + consent card for the user (AC9)", { skip, timeout: 60_000 }, async (t) => {
  // protects=the agent learns why and the user is offered LibreOffice; fails_when=the call hangs, crashes, or downloads anything; no_claim=the window's «Скачать/Не сейчас» buttons (main.ts route)
  if (rt.libreOffice().installed || win) return t.skip("LibreOffice or Office may be present here");
  const copy = path.join(docs, "Отчёт (правки агента).xlsx");
  const before = loNeeded;
  const r = await call("office_recalc", { path: copy });
  assert.equal(r.isError, true);
  assert.match(text(r), /пересчёт недоступен/);
  assert.equal(loNeeded, before + 1);
  assert.equal(rt.libreOffice().installed, false, "nothing was downloaded");
});

test("propose → pending; status by copy and by original", { skip, timeout: 60_000 }, async () => {
  // protects=the review handoff the window shows; fails_when=propose does not register or status lies; no_claim=replace/cancel (edits tests)
  const copy = path.join(docs, "Отчёт (правки агента).xlsx");
  const r = await call("office_propose", { path: copy, summary: "добавил столбец C" });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(text(await call("office_status", { path: copy })), "pending");
  assert.equal(text(await call("office_status", { path: path.join(docs, "Отчёт.xlsx") })), "pending");
  assert.ok(edits.pending().some((e) => e.copy === copy && e.summary === "добавил столбец C"));
});

test("LibreOffice: two recalcs at once both succeed through one queue (R13)", { skip, timeout: 300_000 }, async (t) => {
  // protects=parallel agent calls do not collide in one soffice profile; fails_when=the queue is removed; no_claim=PowerPoint COM single instance (no Office in CI)
  if (!rt.libreOffice().installed) return t.skip("needs LibreOffice installed by the bridge (Windows CI)");
  const a = text(await call("office_copy", { path: path.join(docs, "Отчёт.xlsx") })).match(/Working copy: (.*)/)?.[1] ?? "";
  const b = text(await call("office_copy", { path: path.join(docs, "Отчёт.xlsx") })).match(/Working copy: (.*)/)?.[1] ?? "";
  const [ra, rb] = await Promise.all([call("office_recalc", { path: a }), call("office_recalc", { path: b })]);
  for (const r of [ra, rb]) {
    assert.notEqual(r.isError, true, text(r));
    const j = JSON.parse(text(r)) as { formulas: number; errors: unknown[]; cells: { value: unknown }[] };
    assert.equal(j.errors.length, 0);
    assert.ok(j.cells.some((c) => c.value === 6), "=SUM(A1:A3) computed");
  }
});
