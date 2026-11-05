// Guard for agent office scripts: AST pre-flight + deny-by-default audit hook (core/runtime/guard.py).
// Spawns the real guard under the office venv Python: the pinned runtime the client gets
// (core/.cache/test-office-runtime, shared with office-runtime/office-ops tests), or SB_OFFICE_PYTHON.
// Each test carries a protects/fails_when/no_claim profile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OfficeRuntime } from "../src/office/runtime.ts";

const GUARD = fileURLToPath(new URL("../runtime/guard.py", import.meta.url));
const win = process.platform === "win32";
const supported = (win || process.platform === "linux") && process.arch === "x64";
const rt = new OfficeRuntime({ dataDir: path.resolve(".cache/test-office-runtime"), runtimeSrc: path.resolve("runtime") });
const PY = process.env.SB_OFFICE_PYTHON ?? (supported ? rt.python() : undefined);
const skip: false | string = PY ? false : "office runtime is pinned for windows/linux x64 only";

before(async () => {
  if (process.env.SB_OFFICE_PYTHON || !supported) return;
  await rt.ensure();
  assert.equal(rt.status().state, "ready", rt.status().message);
});
after(() => rt.close?.());

type Run = { code: number | null; stdout: string; stderr: string };
function guard(args: string[], cwd?: string): Run {
  const r = spawnSync(PY as string, ["-I", "-B", "-X", "utf8", GUARD, ...args], { encoding: "utf8", cwd });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
// Setup-only Python, run without the guard (fixtures need real openpyxl/docx files).
function py(code: string): string {
  const r = spawnSync(PY as string, ["-I", "-c", code], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("fixture python failed: " + r.stderr);
  return r.stdout.trim();
}

function sandbox() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sb-guard-")));
  const folder = path.join(dir, "folder");
  const newroot = path.join(dir, "newroot");
  const tmp = path.join(dir, "temp");
  const outside = path.join(dir, "outside");
  const scripts = path.join(dir, "scripts"); // the script's own dir becomes a read root; keep it apart
  for (const d of [folder, newroot, tmp, outside, scripts]) fs.mkdirSync(d);
  const manifest = path.join(dir, "manifest.json");
  const scriptPath = path.join(scripts, "script.py");
  const policyPath = path.join(dir, "policy.json");
  const api = {
    dir, folder, newroot, tmp, outside, manifest,
    policy(writeFiles: string[] = []) {
      fs.writeFileSync(policyPath, JSON.stringify({
        read_roots: [folder], write_files: writeFiles, new_file_roots: [newroot], temp_dir: tmp, manifest,
      }));
      return policyPath;
    },
    run(body: string, writeFiles: string[] = []): Run {
      const p = api.policy(writeFiles);
      fs.writeFileSync(scriptPath, body);
      return guard(["run", p, scriptPath], folder);
    },
    check(body: string): { ok: boolean; problems: Array<{ line: number; kind: string; detail: string; reason: string }> } {
      fs.writeFileSync(scriptPath, body);
      const r = guard(["check", scriptPath]);
      assert.equal(r.code, 0, "check always exits 0: " + r.stderr);
      return JSON.parse(r.stdout.trim());
    },
    manifestJson(): { created: string[]; denied: Record<string, string> | null } {
      return JSON.parse(fs.readFileSync(manifest, "utf8"));
    },
  };
  return api;
}
const Q = (p: string) => JSON.stringify(p); // embed a path as a Python string literal

// A reader never set up in CI must still make CI fail, so this one is not skipped.
test("office venv Python is configured in CI", () => {
  // protects=guard suite actually runs in CI; fails_when=the office runtime is not installed on CI; no_claim=non-x64 dev machines (skip)
  if (process.env.CI) assert.ok(PY && fs.existsSync(PY), "the office runtime Python must exist in CI");
});

// ---------- AST rejections (guard.py check): one test per rule ----------

const astCases: Array<[string, string, string]> = [
  // [name, script, expected substring in a problem detail]
  ["import os", "import os\n", "import os"],
  ["__import__", '__import__("os")\n', "__import__"],
  ["getattr", "x = getattr(o, 'a')\n", "getattr"],
  ["underscore attribute x._y", "y = o._secret\n", "._secret"],
  ["().__class__", "c = ().__class__\n", ".__class__"],
  ['__builtins__["__import__"]', 'f = __builtins__["__import__"]\n', "__builtins__"],
  ["pd.read_xml", "import pandas as pd\npd.read_xml('a')\n", "read_xml"],
  ["etree.XSLT", "from lxml import etree\netree.XSLT(t)\n", "XSLT"],
  ["pd.read_pickle", "import pandas as pd\npd.read_pickle('a')\n", "read_pickle"],
  ["import lxml", "import lxml\n", "import lxml"],
  ["import pypdfium2", "import pypdfium2\n", "import pypdfium2"],
];
for (const [name, script, needle] of astCases) {
  test(`AST rejects: ${name}`, { skip }, () => {
    // protects=pool import/name/attr rules incl. underscore names (R6); fails_when=the rule is dropped or name-only check regresses; no_claim=C-extension I/O bypass (accepted residual risk D3)
    const box = sandbox();
    const res = box.check(script);
    assert.equal(res.ok, false, `${name} should be rejected`);
    assert.ok(res.problems.some((p) => p.detail.includes(needle)), `a problem should mention ${needle}: ${JSON.stringify(res.problems)}`);
    assert.ok(res.problems.every((p) => p.reason.length > 0), "every problem carries a Russian reason");
  });
}

test("AST: a clean openpyxl script passes", { skip }, () => {
  // protects=guard does not false-reject legitimate office code; fails_when=allow-list too narrow; no_claim=runtime behaviour (covered by run tests)
  const box = sandbox();
  const res = box.check("import openpyxl\nwb = openpyxl.load_workbook('a.xlsx')\nwb.save('b.xlsx')\n");
  assert.deepEqual(res, { ok: true });
});

test("AST: a syntax error reports kind=syntax", { skip }, () => {
  // protects=honest syntax reason to the client; fails_when=crash or wrong kind; no_claim=none beyond protects
  const box = sandbox();
  const res = box.check("def (:\n");
  assert.equal(res.ok, false);
  assert.equal(res.problems[0].kind, "syntax");
});

// ---------- runtime hook: denials (deny-by-default) ----------

test("hook aborts: open read outside the allowed folders", { skip }, () => {
  // protects=no read of client files outside allowed folders (R6); fails_when=read roots widen; no_claim=none beyond protects
  const box = sandbox();
  const secret = path.join(box.outside, "secret.txt");
  fs.writeFileSync(secret, "top");
  const r = box.run(`open(${Q(secret)}).read()\n`);
  assert.equal(r.code, 97);
  assert.ok(r.stderr.includes("BRIDGE-GUARD-DENIED"), r.stderr);
  assert.equal(box.manifestJson().denied?.event, "open");
});

test("hook aborts: write to an existing unregistered original", { skip }, () => {
  // protects=the original is never mutated in place by a script (R6); fails_when=write check skips existing-file rule; no_claim=none beyond protects
  const box = sandbox();
  const orig = path.join(box.folder, "orig.txt");
  fs.writeFileSync(orig, "v1");
  const r = box.run(`open(${Q(orig)}, "a").write("x")\n`);
  assert.equal(r.code, 97);
  assert.match(box.manifestJson().denied?.reason as string, /изменить файл/);
});

test("hook aborts: Path.unlink (os.remove) outside temp", { skip }, () => {
  // protects=no file deletion by pool scripts (R6, probe: unlink unguarded in spec); fails_when=os.remove family allowed outside temp; no_claim=none beyond protects
  const box = sandbox();
  const f = path.join(box.folder, "orig.txt");
  fs.writeFileSync(f, "v1");
  const r = box.run(`import pathlib\npathlib.Path(${Q(f)}).unlink()\n`);
  assert.equal(r.code, 97);
  assert.equal(box.manifestJson().denied?.event, "os.remove");
});

test("hook aborts: Path.rename (os.rename)", { skip }, () => {
  // protects=no renaming of client files (R6); fails_when=os.rename allowed; no_claim=none beyond protects
  const box = sandbox();
  const f = path.join(box.folder, "orig.txt");
  fs.writeFileSync(f, "v1");
  const r = box.run(`import pathlib\npathlib.Path(${Q(f)}).rename(${Q(path.join(box.folder, "x.txt"))})\n`);
  assert.equal(r.code, 97);
  assert.equal(box.manifestJson().denied?.event, "os.rename");
});

test("hook aborts: an event not on the allow-list (os.chmod via pathlib)", { skip }, () => {
  // protects=deny-by-default — any non-allowlisted audit event aborts (R6); fails_when=hook defaults to allow; no_claim=none beyond protects
  const box = sandbox();
  const f = path.join(box.folder, "orig.txt");
  fs.writeFileSync(f, "v1");
  const r = box.run(`import pathlib\npathlib.Path(${Q(f)}).chmod(0o644)\n`);
  assert.equal(r.code, 97);
  assert.equal(box.manifestJson().denied?.event, "os.chmod");
});

for (const mod of ["subprocess", "socket", "ctypes"]) {
  test(`run rejects a script importing ${mod} before executing it`, { skip }, () => {
    // protects=process/network/native-call modules never load in a pool run (R6); fails_when=import allow-list widens; no_claim=reached via already-imported C-extension (accepted residual risk D3)
    const box = sandbox();
    const r = box.run(`import ${mod}\n`);
    assert.equal(r.code, 98, r.stderr);
    assert.ok(r.stderr.includes("BRIDGE-GUARD-REJECTED"), r.stderr);
  });
}

test("os.startfile is blocked on Windows", { skip: win ? skip : "Windows only (os.startfile does not exist elsewhere)" }, () => {
  // protects=no program launch via os.startfile on Windows (R6); fails_when=startfile reachable from a pool script; no_claim=other Win32 launch paths via ctypes (ctypes blocked separately)
  const box = sandbox();
  const r = box.run(`import os\nos.startfile(${Q(box.folder)})\n`);
  // import os is AST-rejected first (98); the runtime hook also denies the os.startfile event as a second layer.
  assert.ok(r.code === 98 || r.code === 97, `blocked with ${r.code}: ${r.stderr}`);
});

// ---------- runtime hook: allowances ----------

test("hook allows: reading a stdlib file under sys.base_prefix", { skip }, () => {
  // protects=interpreter files remain readable (R6 read roots); fails_when=base_prefix dropped from read roots; no_claim=none beyond protects
  const box = sandbox();
  const stringPy = py("import string; print(string.__file__)");
  const r = box.run(`print(open(${Q(stringPy)}, encoding="utf-8").read()[:5])\n`);
  assert.equal(r.code, 0, r.stderr);
});

test("hook allows: write into a registered copy; manifest stays empty", { skip }, () => {
  // protects=editing the registered copy works and is not reported as a new file (R6/R9); fails_when=write_files rule missing; no_claim=none beyond protects
  const box = sandbox();
  const copy = path.join(box.folder, "Отчёт (правки агента).xlsx");
  py(`import openpyxl; wb=openpyxl.Workbook(); wb.active['A1']=1; wb.save(${JSON.stringify(copy)})`);
  const r = box.run(`import openpyxl\nwb = openpyxl.load_workbook(${Q(copy)})\nwb.active["B1"] = "ok"\nwb.save(${Q(copy)})\nprint("ok")\n`, [copy]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(box.manifestJson(), { created: [], denied: null });
});

test("hook allows: a new file inside new_file_roots; manifest lists it", { skip }, () => {
  // protects=agent-created files are allowed and recorded (R9); fails_when=manifest not written or new-file rule missing; no_claim=none beyond protects
  const box = sandbox();
  const out = path.join(box.newroot, "new.docx");
  const r = box.run(`import docx\nd = docx.Document()\nd.add_paragraph("Новый")\nd.save(${Q(out)})\nprint("made")\n`);
  assert.equal(r.code, 0, r.stderr);
  const m = box.manifestJson();
  assert.equal(m.denied, null);
  assert.ok(m.created.some((p) => p.toLowerCase().endsWith("new.docx")), JSON.stringify(m.created));
});

test("hook allows: writing into temp_dir, not recorded in the manifest", { skip }, () => {
  // protects=run temp is writable without polluting the created list (R6); fails_when=temp_dir not allowed or temp files listed; no_claim=none beyond protects
  const box = sandbox();
  const r = box.run(`import pathlib\n(pathlib.Path(${Q(box.tmp)}) / "scratch.txt").write_text("hi")\nprint("ok")\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(box.manifestJson(), { created: [], denied: null });
});

test("no .pyc files are written during a run", { skip }, () => {
  // protects=-B/dont_write_bytecode holds, so no stray writes (test plan); fails_when=bytecode writing re-enabled; no_claim=none beyond protects
  const box = sandbox();
  const out = path.join(box.newroot, "n.docx");
  const r = box.run(`import docx\ndocx.Document().save(${Q(out)})\n`);
  assert.equal(r.code, 0, r.stderr);
  const pyc: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".pyc")) pyc.push(p);
    }
  };
  walk(box.dir);
  assert.deepEqual(pyc, [], "no .pyc under the sandbox");
});

// ---------- positive end-to-end scenarios ----------

test("positive: openpyxl edits a copy and it is accepted", { skip }, () => {
  // protects=the core edit path (openpyxl -> registered copy) runs clean (AC4); fails_when=a library op trips the hook; no_claim=Office COM (E2E only)
  const box = sandbox();
  const copy = path.join(box.folder, "Отчёт (правки агента).xlsx");
  py(`import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws['A1']=1; ws['A2']=2; wb.save(${JSON.stringify(copy)})`);
  const r = box.run(`import openpyxl\nwb = openpyxl.load_workbook(${Q(copy)})\nwb.active["A3"] = "=SUM(A1:A2)"\nwb.save(${Q(copy)})\nprint("edited")\n`, [copy]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /edited/);
});

test("positive: python-docx creates a new docx", { skip }, () => {
  // protects=new-document path (python-docx) runs clean and is registered (AC4, D1); fails_when=docx save blocked; no_claim=none beyond protects
  const box = sandbox();
  const out = path.join(box.newroot, "report.docx");
  const r = box.run(`import docx\nd = docx.Document()\nd.add_heading("Отчёт", level=1)\nd.add_paragraph("Текст")\nd.save(${Q(out)})\nprint("created")\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /created/);
  assert.ok(fs.existsSync(out));
  assert.ok(box.manifestJson().created.some((p) => p.toLowerCase().endsWith("report.docx")));
});
