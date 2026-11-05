// office_ops.py (T4) through the real runtime (core/.cache/test-office-runtime, shared with office-runtime.test.ts).
// read / legacy / XLM / detect / PDF render run on any OS. LibreOffice cases need SB_SOFFICE (Windows CI sets it
// in T8); without it they are skipped with the reason. Fixtures are built by the venv's own libraries.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { OfficeRuntime, killTree } from "../src/office/runtime.ts";

const win = process.platform === "win32";
const supported = (win || process.platform === "linux") && process.arch === "x64";
const skip = supported ? false : "office runtime is pinned for windows/linux x64 only";
const soffice = process.env.SB_SOFFICE;
const loSkip = !supported ? skip : soffice && fs.existsSync(soffice) ? false : "needs LibreOffice: set SB_SOFFICE=<path to soffice> (Windows CI, T8)";
const runtimeSrc = path.resolve("runtime");
const dataDir = path.resolve(".cache/test-office-runtime");
const fixtures = path.resolve("test/office-fixtures.py");

let rt: OfficeRuntime;
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sb-office-ops-")));
const work = path.join(dir, "work");
const f = (name: string) => path.join(dir, name);
let n = 0;

type Res = { ok: boolean; code?: string; error?: string; [k: string]: unknown };
async function op(name: string, args: Record<string, unknown>): Promise<Res> {
  const argsFile = path.join(dir, `args-${++n}.json`);
  fs.writeFileSync(argsFile, JSON.stringify(args));
  const r = await rt.runPy("office_ops.py", [name, argsFile], { timeoutMs: 600_000 });
  const last = r.stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(last);
  } catch {
    throw new Error(`no JSON result (code ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
}

function fixture(kind: string, out: string, ...rest: string[]) {
  execFileSync(rt.python(), ["-I", fixtures, kind, out, ...rest], { stdio: ["ignore", "ignore", "inherit"] });
  return out;
}

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const pngWidth = (p: string) => {
  const b = fs.readFileSync(p);
  assert.equal(b.subarray(1, 4).toString(), "PNG");
  return b.readUInt32BE(16);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!supported) return;
  rt = new OfficeRuntime({ dataDir, runtimeSrc });
  await rt.ensure();
  assert.equal(rt.status().state, "ready", rt.status().message);
  fixture("docx", f("Отчёт.docx"));
  fixture("xlsx", f("Таблица.xlsx"));
  fixture("pptx", f("Слайды.pptx"));
  fixture("pdf", f("Документ.pdf"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// protects=AC2 read path: markitdown text of docx/xlsx/pptx/pdf lands in `out` as UTF-8 (Cyrillic names and text), result JSON is the last stdout line; fails_when=markitdown extras missing from the lock, library chatter breaks the JSON line, encoding breaks; no_claim=64 KB paging/offset (policy, T6), .xls (LibreOffice block)
test("read docx / xlsx / pptx / pdf", { skip, timeout: 120_000 }, async () => {
  const cases: [string, RegExp][] = [
    ["Отчёт.docx", /DOCX-MARKER[\s\S]*Первая страница/],
    ["Таблица.xlsx", /XLSX-MARKER[\s\S]*Лист1|Лист1[\s\S]*XLSX-MARKER/],
    ["Слайды.pptx", /Слайд PPTX-MARKER/],
    ["Документ.pdf", /PDF-MARKER first page[\s\S]*second page/],
  ];
  for (const [name, want] of cases) {
    const out = path.join(dir, `${name}.md`);
    const r = await op("read", { path: f(name), out });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = fs.readFileSync(out, "utf8");
    assert.equal(r.chars, text.length);
    assert.match(text, want, name);
  }
});

// protects=R10 honest contract: .doc/.ppt -> legacy_format «сначала office_convert», nothing written; fails_when=legacy files are silently read as empty or garbage; no_claim=.xls (read in the LibreOffice block)
test("read .doc / .ppt -> legacy_format", { skip, timeout: 60_000 }, async () => {
  for (const name of ["Старый.doc", "Старая.ppt"]) {
    fs.writeFileSync(f(name), Buffer.from("d0cf11e0a1b11ae1", "hex"));
    const out = f(`${name}.md`);
    const r = await op("read", { path: f(name), out });
    assert.equal(r.ok, false);
    assert.equal(r.code, "legacy_format");
    assert.match(r.error!, /сначала office_convert/);
    assert.ok(!fs.existsSync(out));
  }
});

// protects=AC14/R7 Excel 4.0 macro books never reach Excel or LibreOffice: xl/macrosheets/ part and BIFF BOUNDSHEET type 1, checked before any open; fails_when=check removed, done after opening, or blanket-refuses every .xls; no_claim=encrypted .xls (sheet type hidden by RC4)
test("Excel 4.0 macro sheets are refused before any open", { skip, timeout: 120_000 }, async () => {
  const fakeSoffice = path.join(dir, "no-such-soffice");
  const common = { backend: "libreoffice", soffice: fakeSoffice, work_dir: work };
  const xlsm = fixture("xlsx-xlm", f("Макросы.xlsm"));
  const before = sha(xlsm);
  for (const [name, args] of [
    ["recalc", { path: xlsm }],
    ["render", { path: xlsm, pages: [1] }],
    ["convert", { path: xlsm, to: "pdf", out: f("m1.pdf") }],
  ] as const) {
    const r = await op(name, { ...common, ...args });
    assert.equal(r.code, "xlm_macros", `${name}: ${JSON.stringify(r)}`);
  }
  assert.equal(sha(xlsm), before);

  const xls = fixture("xls-xlm", f("Старая книга.xls"));
  for (const [name, args] of [
    ["recalc", { path: xls }],
    ["convert", { path: xls, to: "xlsx", out: f("m2.xlsx") }],
    ["render", { path: xls }],
  ] as const) {
    const r = await op(name, { ...common, ...args });
    assert.equal(r.code, "xlm_macros", `${name}: ${JSON.stringify(r)}`);
  }
  // control: the same BIFF book with an ordinary sheet goes on to the backend (absent here)
  const plain = fixture("xls-plain", f("Обычная книга.xls"));
  const r = await op("convert", { ...common, path: plain, to: "xlsx", out: f("m3.xlsx") });
  assert.equal(r.code, "no_backend", JSON.stringify(r));
  assert.ok(!fs.existsSync(f("m1.pdf")) && !fs.existsSync(f("m2.xlsx")));
});

// protects=detect contract: no Office outside Windows, soffice found only as <dir>/…/program/soffice(.exe); fails_when=detect reports Office on Linux or misses an unpacked LibreOffice; no_claim=HKCR COM lookup with real Office (E2E on Ilya's PC)
test("detect", { skip, timeout: 60_000 }, async () => {
  const lo = path.join(dir, "libreoffice");
  let r = await op("detect", { libreoffice_dir: lo });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.soffice, null);
  const office = r.office as Record<string, boolean>;
  assert.deepEqual(Object.keys(office).sort(), ["excel", "powerpoint", "word"]);
  if (!win) assert.deepEqual(office, { excel: false, word: false, powerpoint: false });
  else for (const v of Object.values(office)) assert.equal(typeof v, "boolean");
  const prog = path.join(lo, "PFiles", "LibreOffice", "program");
  fs.mkdirSync(prog, { recursive: true });
  fs.writeFileSync(path.join(prog, win ? "soffice.exe" : "soffice"), "");
  r = await op("detect", { libreoffice_dir: lo });
  assert.equal(r.soffice, path.join(prog, win ? "soffice.exe" : "soffice"));
});

// protects=AC7 render step PDF -> PNG (pypdfium2) at width 1200, at most 3 pages, pages past the end skipped; fails_when=scale/width or page cap breaks; no_claim=Office/LibreOffice -> PDF step (LibreOffice block, COM E2E)
test("render a PDF to PNG", { skip, timeout: 60_000 }, async () => {
  const r = await op("render", { path: f("Документ.pdf"), pages: [2, 1, 2, 9, 3, 4], width: 1200, work_dir: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.page_count, 2);
  const images = r.images as { page: number; png: string }[];
  assert.deepEqual(images.map((i) => i.page), [2, 1]);
  for (const i of images) assert.equal(pngWidth(i.png), 1200);
});

// protects=AC9 without Office and LibreOffice the agent gets a plain error; convert never overwrites an existing file and checks the target format; fails_when=ops crash, overwrite, or accept nonsense targets; no_claim=consent card (T6/T7)
test("no backend, existing out, wrong target -> plain errors", { skip, timeout: 60_000 }, async () => {
  const xlsx = f("Таблица.xlsx");
  const before = sha(xlsx);
  let r = await op("recalc", { path: xlsx, work_dir: work });
  assert.equal(r.code, "no_backend");
  assert.match(r.error!, /нет Microsoft Office/);
  assert.equal(sha(xlsx), before);
  fs.writeFileSync(f("занят.pdf"), "client file");
  r = await op("convert", { path: f("Отчёт.docx"), to: "pdf", out: f("занят.pdf"), backend: "libreoffice", soffice: soffice ?? "x", work_dir: work });
  assert.equal(r.code, "out_exists");
  assert.equal(fs.readFileSync(f("занят.pdf"), "utf8"), "client file");
  r = await op("convert", { path: f("Отчёт.docx"), to: "xlsx", out: f("x.xlsx"), backend: "libreoffice", work_dir: work });
  assert.equal(r.code, "bad_target");
  r = await op("nope", {});
  assert.equal(r.code, "bad_op");
});

// ---------- LibreOffice (SB_SOFFICE) ----------

const lo = { backend: "libreoffice", soffice, work_dir: work };

// protects=AC6 via LibreOffice: the recalc-on-load profile computes =SUM(A1:A3)=6 with 0 errors and reports #DIV/0! by cell; fails_when=recalc key wrong, file not written back, or the scan misses errors; no_claim=Excel COM path (E2E on Ilya's PC)
test("LibreOffice: recalc =SUM(A1:A3)", { skip: loSkip, timeout: 600_000 }, async () => {
  const book = fixture("xlsx", f("Пересчёт.xlsx"));
  let r = await op("recalc", { ...lo, path: book, profile: path.join(dir, "lo-profile") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.formulas, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cells, [{ sheet: "Лист1", cell: "A4", formula: "=SUM(A1:A3)", value: 6 }]);
  const bad = fixture("xlsx-errors", f("Ошибки.xlsx"));
  r = await op("recalc", { ...lo, path: bad, profile: path.join(dir, "lo-profile") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.errors, [{ sheet: "Sheet", cell: "A2", value: "#DIV/0!" }]);
});

// protects=AC7 via LibreOffice: PNG of the first docx page and the first pptx slide, width 1200; fails_when=PDF export or render breaks; no_claim=COM ExportAsFixedFormat (E2E)
test("LibreOffice: render docx page 1 and pptx slide 1", { skip: loSkip, timeout: 600_000 }, async () => {
  for (const name of ["Отчёт.docx", "Слайды.pptx"]) {
    const r = await op("render", { ...lo, path: f(name), pages: [1], profile: path.join(dir, "lo-profile") });
    assert.equal(r.ok, true, JSON.stringify(r));
    const images = r.images as { page: number; png: string }[];
    assert.equal(images.length, 1);
    assert.equal(pngWidth(images[0].png), 1200);
  }
});

// protects=R10 .xls is read by markitdown (xlrd extra in the lock); fails_when=xls extra dropped from the lock; no_claim=BIFF5 and older books
test("LibreOffice: .xls is read", { skip: loSkip, timeout: 600_000 }, async () => {
  const outDir = path.join(dir, "xls");
  const profile = path.join(dir, "xls-profile");
  execFileSync(soffice!, ["--headless", "--norestore", `-env:UserInstallation=${pathToFileURL(profile).href}`, "--convert-to", "xls", "--outdir", outDir, f("Таблица.xlsx")], { stdio: "ignore", timeout: 300_000 });
  const xls = path.join(outDir, "Таблица.xls");
  const r = await op("read", { path: xls, out: f("xls.md") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(fs.readFileSync(f("xls.md"), "utf8"), /XLSX-MARKER/);
});

function permissiveProfile(profile: string) {
  const items = [
    ["MacroSecurityLevel", "0"],
    ["DisableMacrosExecution", "false"],
  ].map(([k, v]) => `<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="${k}" oor:op="fuse"><value>${v}</value></prop></item>`);
  fs.mkdirSync(path.join(profile, "user"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "user", "registrymodifications.xcu"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${items.join("\n")}\n</oor:items>\n`,
  );
}

// opens the document the way a person would (macros follow the profile), waits for the marker, kills soffice
async function openAndWatch(profile: string, doc: string, marker: string, ms: number): Promise<number | null> {
  const t0 = Date.now();
  const p = spawn(soffice!, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(profile).href}`, doc], { stdio: "ignore", detached: !win });
  try {
    while (Date.now() - t0 < ms) {
      if (fs.existsSync(marker)) return Date.now() - t0;
      await sleep(250);
    }
    return null;
  } finally {
    if (p.pid) killTree(p.pid);
    await sleep(2000);
  }
}

// protects=AC14 (ODF Basic stand-in for .xlsm, see report): with our profile a document macro on open does not run, through office_ops and through a plain open; a permissive profile runs the same macro (positive control); fails_when=profile macro keys are wrong or ignored, or the fixture cannot run macros at all; no_claim=VBA in .xlsm (needs a VBA project authored by Office), Office COM ForceDisable (E2E)
test("LibreOffice: document macros do not run with our profile", { skip: loSkip, timeout: 900_000 }, async () => {
  const marker = path.join(dir, "macro-ran.txt");
  const doc = fixture("odt-macro", f("Макрос.odt"), marker);

  // positive control: same document, permissive profile -> marker appears
  const open = path.join(dir, "lo-open-profile");
  permissiveProfile(open);
  const tookMs = await openAndWatch(open, doc, marker, 180_000);
  assert.ok(tookMs !== null, "positive control: the macro never ran with a permissive profile — the test proves nothing");
  fs.rmSync(marker);

  // through office_ops (convert + render), with the profile office_ops writes
  const ours = path.join(dir, "lo-our-profile");
  let r = await op("convert", { ...lo, path: doc, to: "pdf", out: f("Макрос.pdf"), profile: ours });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await op("render", { ...lo, path: doc, profile: ours });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!fs.existsSync(marker), "macro ran during office_ops");

  // plain open with our profile, waiting well past the control's time
  const ran = await openAndWatch(ours, doc, marker, Math.min(180_000, Math.max(20_000, 3 * tookMs!)));
  assert.equal(ran, null, "macro ran with our profile");
});
