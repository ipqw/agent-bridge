import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { Edits } from "../src/office/edits.ts";

const win = process.platform === "win32";
const NOW = new Date(2026, 9, 20, 12, 0, 0); // local time → backups/2026-10-20
const DAY = "2026-10-20";

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const ino = (p: string) => fs.statSync(p, { bigint: true }).ino;
const read = (p: string) => fs.readFileSync(p, "utf8");

function setup(t: TestContext, o: { dataRoot?: string; content?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-edits-"));
  const data = o.dataRoot ? fs.mkdtempSync(path.join(o.dataRoot, "sb-edits-data-")) : path.join(root, "data");
  const docs = path.join(root, "Документы");
  fs.mkdirSync(docs);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (o.dataRoot) fs.rmSync(data, { recursive: true, force: true });
  });
  const orig = path.join(docs, "Отчёт.xlsx");
  fs.writeFileSync(orig, o.content ?? "original bytes, longer than the edited copy");
  const edits = (x: { windows?: boolean } = {}) => new Edits(data, { now: () => NOW, ...x });
  return { data, docs, orig, edits, backups: path.join(data, "backups", DAY) };
}

// copy → edit the copy → propose; returns the record
function proposed(e: Edits, orig: string, edited = "edited") {
  const rec = e.copy(orig);
  fs.writeFileSync(rec.copy, edited);
  return e.propose(rec.copy, "пересчитал итоги");
}

test("copy: «(правки агента)», then «(правки агента 2)», a foreign file is skipped, never overwritten", (t) => {
  // protects=AC3 copy names and «оригинал не меняется никогда» for neighbours; fails_when=a copy reuses or overwrites an existing file name; no_claim=Windows-only name limits (reserved names, MAX_PATH)
  const { docs, orig, edits } = setup(t);
  const e = edits();
  const a = e.copy(orig);
  const b = e.copy(orig);
  assert.equal(a.copy, path.join(docs, "Отчёт (правки агента).xlsx"));
  assert.equal(b.copy, path.join(docs, "Отчёт (правки агента 2).xlsx"));
  const foreign = path.join(docs, "Отчёт (правки агента 3).xlsx");
  fs.writeFileSync(foreign, "чужой файл клиента");
  const c = e.copy(orig);
  assert.equal(c.copy, path.join(docs, "Отчёт (правки агента 4).xlsx"));
  assert.equal(read(foreign), "чужой файл клиента");
  for (const r of [a, b, c]) assert.equal(read(r.copy), read(orig));
  assert.throws(() => e.copy(a.copy), /уже рабочая копия/);
  assert.throws(() => e.copy(path.join(docs, "нет такого.xlsx")), /не найден/);
});

test("copy: the original's sha256 is unchanged and recorded in edits.json", (t) => {
  // protects=AC3 sha256 of the original before == after copy and == the value in edits.json; fails_when=copy touches the original or records a hash of something else; no_claim=atime/ADS of the original
  const { data, orig, edits } = setup(t);
  const before = sha(orig);
  const id0 = ino(orig);
  const rec = edits().copy(orig);
  assert.equal(sha(orig), before);
  assert.equal(ino(orig), id0);
  assert.equal(rec.originalSha256, before);
  assert.equal(rec.status, "editing");
  const file = path.join(data, "office", "edits.json");
  const onDisk = JSON.parse(read(file));
  assert.equal(onDisk.edits.length, 1);
  assert.equal(onDisk.edits[0].original, orig);
  assert.equal(onDisk.edits[0].copy, rec.copy);
  assert.equal(onDisk.edits[0].originalSha256, before);
  assert.equal(fs.existsSync(file + ".tmp"), false, "atomic write leaves no tmp file");
});

test("registry survives a restart: copies, statuses, agent files, writable()", (t) => {
  // protects=a new Edits instance reads edits.json back (bridge restart keeps reviews and agent files); fails_when=state lives only in memory or is parsed back wrong; no_claim=two bridge processes writing one registry
  const { docs, orig, edits } = setup(t);
  const e1 = edits();
  const rec = proposed(e1, orig);
  const made = path.join(docs, "Новый отчёт.docx");
  fs.writeFileSync(made, "x");
  e1.registerAgentFiles([made, made]);
  e1.registerAgentFiles([orig]); // an original under review never becomes freely writable

  const e2 = edits();
  assert.deepEqual(e2.get(rec.id), rec);
  assert.equal(e2.get(rec.id)?.summary, "пересчитал итоги");
  assert.equal(e2.statusOf(rec.copy), "pending");
  assert.equal(e2.statusOf(orig), "pending");
  assert.equal(e2.statusOf(made), null);
  assert.equal(e2.isAgentEditable(rec.copy), true);
  assert.equal(e2.isAgentEditable(made), true);
  assert.equal(e2.isAgentEditable(orig), false);
  assert.deepEqual(e2.writable().sort(), [rec.copy, made].sort());
  assert.deepEqual(e2.pending().map((r) => r.id), [rec.id]);
});

test("paths compare without case on Windows, with case elsewhere", (t) => {
  // protects=on Windows C:\Docs\A.xlsx and c:\docs\a.xlsx are one file for the registry; fails_when=a differently cased path misses the copy (agent loses write access or escapes review); no_claim=8.3 short names and links (the policy passes real paths)
  const { orig, edits } = setup(t);
  const w = edits({ windows: true });
  const rec = w.copy(orig);
  assert.equal(w.isAgentEditable(rec.copy.toUpperCase()), true);
  assert.equal(w.statusOf(orig.toUpperCase()), "editing");
  const p = edits({ windows: false });
  assert.equal(p.isAgentEditable(rec.copy.toUpperCase()), false);
  assert.equal(p.isAgentEditable(rec.copy), true);
});

test("propose: only an active agent copy can go on review", (t) => {
  // protects=office_propose rejects originals, agent files and unknown paths with a clear error; fails_when=an arbitrary file can be put on review and later "replace" something; no_claim=exact error wording
  const { docs, orig, edits } = setup(t);
  const e = edits();
  const made = path.join(docs, "Новый.docx");
  fs.writeFileSync(made, "x");
  e.registerAgentFiles([made]);
  assert.throws(() => e.propose(orig, "x"), /не рабочая копия/);
  assert.throws(() => e.propose(made, "x"), /не рабочая копия/);
  assert.throws(() => e.propose(path.join(docs, "нет.xlsx"), "x"), /не рабочая копия/);
  const rec = e.copy(orig);
  let changes = 0;
  e.on("change", () => changes++);
  const p = e.propose(rec.copy, "итоги");
  assert.equal(p.status, "pending");
  assert.equal(p.proposedAt, NOW.toISOString());
  assert.equal(changes, 1);
});

test("replace: in place — same file id, content = copy, backup of the old original first, copy removed", async (t) => {
  // protects=AC8/D5 replace rewrites the original through its own handle (file id kept), backup in backups/<local date>/, copy deleted, a second backup the same day gets a suffix; fails_when=replace renames/recreates the original, skips the backup or leaves the copy; no_claim=NTFS file id/ADS and OneDrive history on Windows (same assertions run in Windows CI, not checked here)
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  const id0 = ino(orig);
  let changes = 0;
  e.on("change", () => changes++);
  const r = await e.replace(rec.id);
  const backup = path.join(backups, "Отчёт.xlsx");
  assert.deepEqual(r, { result: "replaced", backup });
  assert.equal(ino(orig), id0, "same file");
  assert.equal(read(orig), "edited", "content = copy (and the longer old tail is truncated)");
  assert.equal(read(backup), "original bytes, longer than the edited copy");
  assert.equal(fs.existsSync(rec.copy), false);
  const after = e.get(rec.id);
  assert.equal(after?.status, "replaced");
  assert.equal(after?.backup, backup);
  assert.equal(after?.decidedAt, NOW.toISOString());
  assert.equal(e.isAgentEditable(rec.copy), false);
  assert.equal(e.statusOf(orig), "replaced");
  assert.equal(changes, 1);
  assert.equal((await e.replace(rec.id)).result, "gone");

  const rec2 = proposed(e, orig, "edited twice");
  const r2 = await e.replace(rec2.id);
  assert.deepEqual(r2, { result: "replaced", backup: path.join(backups, "Отчёт (2).xlsx") });
  assert.equal(read(path.join(backups, "Отчёт (2).xlsx")), "edited");
  assert.equal(read(orig), "edited twice");
  assert.equal(ino(orig), id0);
});

test("replace: hidden original keeps its attributes and alternate data streams", { skip: win ? false : "Windows only: NTFS attributes and streams" }, async (t) => {
  // protects=D5 «r+, не w»: the original is opened without re-creation, so a hidden file is writable and its attributes/ADS survive; fails_when=open uses "w" (CREATE_ALWAYS: fails on hidden files, resets attributes) or delete+create; no_claim=OneDrive/SharePoint version history
  const { orig, edits } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  fs.writeFileSync(orig + ":bridge-test", "stream kept");
  execFileSync("attrib", ["+h", orig]);
  const id0 = ino(orig);
  assert.equal((await e.replace(rec.id)).result, "replaced");
  assert.equal(read(orig), "edited");
  assert.equal(ino(orig), id0);
  assert.equal(read(orig + ":bridge-test"), "stream kept");
  const attrs = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[System.IO.File]::GetAttributes($env:SB_FILE)"], {
    env: { ...process.env, SB_FILE: orig },
    encoding: "utf8",
  });
  assert.match(attrs, /Hidden/);
});

test("replace: original changed after the copy → stale, nothing changes; force replaces, client's version in backup", async (t) => {
  // protects=D6 a changed original is never overwritten silently; with force the client's newer version lands in the backup; fails_when=stale copy overwrites the original without the card, or force is ignored; no_claim=the card itself (UI, T7)
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "agent edit");
  fs.writeFileSync(orig, "client changed it meanwhile");
  const id0 = ino(orig);
  assert.deepEqual(await e.replace(rec.id), { result: "stale" });
  assert.equal(read(orig), "client changed it meanwhile");
  assert.equal(read(rec.copy), "agent edit");
  assert.equal(fs.existsSync(backups), false, "no backup for a refused replace");
  assert.equal(e.get(rec.id)?.status, "pending");

  const r = await e.replace(rec.id, { force: true });
  assert.equal(r.result, "replaced");
  assert.equal(read(orig), "agent edit");
  assert.equal(ino(orig), id0);
  assert.equal(read(path.join(backups, "Отчёт.xlsx")), "client changed it meanwhile");
});

test("replace: two simultaneous clicks → one replaced, the other busy; a later click → gone", async (t) => {
  // protects=«Повторное нажатие во время замены — замена одна»: second concurrent call returns "busy" (it does not wait), a call after completion returns "gone"; fails_when=both calls back up/write the original; no_claim=two bridge processes on one registry
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  const [a, b] = await Promise.all([e.replace(rec.id), e.replace(rec.id)]);
  assert.equal(a.result, "replaced");
  assert.deepEqual(b, { result: "busy" });
  assert.equal((await e.replace(rec.id)).result, "gone");
  assert.deepEqual(fs.readdirSync(backups), ["Отчёт.xlsx"]);
  assert.equal(read(orig), "edited");
});

test("replace: two copies of one original at once → one replaced, other busy, then stale", async (t) => {
  // protects=replaces of one original never interleave; the second copy then hits the D6 check; fails_when=the second copy silently overwrites the first one's result; no_claim=—
  const { orig, edits } = setup(t);
  const e = edits();
  const one = proposed(e, orig, "first");
  const two = proposed(e, orig, "second");
  const [a, b] = await Promise.all([e.replace(one.id), e.replace(two.id)]);
  assert.equal(a.result, "replaced");
  assert.deepEqual(b, { result: "busy" });
  assert.deepEqual(await e.replace(two.id), { result: "stale" });
  assert.equal(read(orig), "first");
});

test("replace: original held open with FileShare.None → locked, nothing changes", { skip: win ? false : "Windows only: needs a share-mode lock", timeout: 60_000 }, async (t) => {
  // protects=«Закройте файл в Excel и нажмите снова» when another program holds the original; no backup, copy kept, original intact; fails_when=replace recreates/renames the file or reports success while locked; no_claim=a real Excel lock (PowerShell FileShare.None stands in for it)
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  const id0 = ino(orig);
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-Command", "$f = [System.IO.File]::Open($env:SB_LOCK, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()"],
    { env: { ...process.env, SB_LOCK: orig }, stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = new Promise<void>((resolve) => ps.on("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      ps.stdout!.on("data", (d) => {
        out += d;
        if (out.includes("locked")) resolve();
      });
      ps.on("exit", (c) => reject(new Error(`powershell exited ${c} before locking`)));
    });
    assert.deepEqual(await e.replace(rec.id), { result: "locked", message: "Закройте файл в Excel и нажмите снова" });
    assert.equal(fs.existsSync(backups), false);
    assert.equal(read(rec.copy), "edited");
    assert.equal(e.get(rec.id)?.status, "pending");
  } finally {
    ps.stdin!.end();
    await exited;
  }
  assert.equal(read(orig), "original bytes, longer than the edited copy");
  assert.equal(ino(orig), id0);
  assert.equal((await e.replace(rec.id)).result, "replaced");
});

test("replace: original not writable (read-only) → locked with a read-only hint, nothing changes", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async (t) => {
  // protects=an original that cannot be opened r+ yields "locked" (no backup, copy kept), never a recreated file; fails_when=replace falls back to delete+create or reports success; no_claim=Excel's share lock (Windows-only test above)
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  fs.chmodSync(orig, 0o444); // rm in cleanup copes with read-only files (Node's rimraf fixes EPERM on Windows)
  const r = await e.replace(rec.id);
  assert.equal(r.result, "locked");
  assert.match((r as { message: string }).message, /только для чтения/);
  assert.equal(fs.existsSync(backups), false);
  assert.equal(read(orig), "original bytes, longer than the edited copy");
  assert.equal(read(rec.copy), "edited");
  fs.chmodSync(orig, 0o644);
  assert.equal((await e.replace(rec.id)).result, "replaced");
});

test("replace: copy deleted by the client → gone, original untouched; cancel still closes the record", async (t) => {
  // protects=missing copy gives "gone" with a message instead of an error or an emptied original; fails_when=replace throws or truncates the original; no_claim=—
  const { orig, edits } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  fs.rmSync(rec.copy);
  const r = await e.replace(rec.id);
  assert.equal(r.result, "gone");
  assert.match((r as { message: string }).message, /Копия/);
  assert.equal(read(orig), "original bytes, longer than the edited copy");
  assert.deepEqual(await e.cancel(rec.id), { ok: true, message: "Копии уже нет — правки закрыты" });
  assert.equal(e.get(rec.id)?.status, "cancelled");
});

test("cancel: copy moves to backups/<date>/, original untouched, record closed", async (t) => {
  // protects=AC8 «Отменить правки»: copy kept 30 days in backups, original byte- and id-identical; fails_when=cancel deletes the copy outright, touches the original or leaves the copy writable; no_claim=cross-disk move (next test)
  const { orig, edits, backups } = setup(t);
  const e = edits();
  const rec = proposed(e, orig, "edited");
  const sha0 = sha(orig);
  const id0 = ino(orig);
  assert.deepEqual(await e.cancel(rec.id), { ok: true });
  const moved = path.join(backups, "Отчёт (правки агента).xlsx");
  assert.equal(read(moved), "edited");
  assert.equal(fs.existsSync(rec.copy), false);
  assert.equal(sha(orig), sha0);
  assert.equal(ino(orig), id0);
  assert.equal(e.get(rec.id)?.status, "cancelled");
  assert.equal(e.get(rec.id)?.backup, moved);
  assert.equal(e.isAgentEditable(rec.copy), false);
  assert.deepEqual(e.writable(), []);
  assert.equal((await e.cancel(rec.id)).ok, false);
  assert.equal((await e.replace(rec.id)).result, "gone");
  fs.writeFileSync(rec.copy, "stray");
  assert.throws(() => e.propose(rec.copy, "x"), /закрыты/);
});

const shmOther = !win && fs.existsSync("/dev/shm") && fs.statSync("/dev/shm").dev !== fs.statSync(os.tmpdir()).dev;
test("cancel and replace across filesystems (rename → EXDEV → copy + delete)", { skip: shmOther ? false : "needs /dev/shm on another filesystem than os.tmpdir()" }, async (t) => {
  // protects=dataDir on another disk than the documents: cancel moves the copy by copy+delete, replace still works in place; fails_when=EXDEV surfaces as an error and the copy stays; no_claim=Windows drive letters (C: vs D:) — same code path, not run here
  const { orig, edits, backups } = setup(t, { dataRoot: "/dev/shm" });
  const e = edits();
  const one = proposed(e, orig, "first");
  assert.deepEqual(await e.cancel(one.id), { ok: true });
  assert.equal(read(path.join(backups, "Отчёт (правки агента).xlsx")), "first");
  assert.equal(fs.existsSync(one.copy), false);
  const two = proposed(e, orig, "second");
  const id0 = ino(orig);
  assert.equal((await e.replace(two.id)).result, "replaced");
  assert.equal(read(orig), "second");
  assert.equal(ino(orig), id0);
});

test("purgeBackups: date folders older than 30 days (local) are removed, others kept", (t) => {
  // protects=backups live 30 days by injected time; non-date entries and recent days survive; fails_when=fresh backups are deleted or old ones kept forever; no_claim=time-zone changes between runs
  const { data, edits } = setup(t);
  const root = path.join(data, "backups");
  for (const d of ["2026-08-01", "2026-09-19", "2026-09-20", "2026-10-20", "notes"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, d, "a.xlsx"), "x");
  }
  const e = edits();
  e.purgeBackups();
  assert.deepEqual(fs.readdirSync(root).sort(), ["2026-09-20", "2026-10-20", "notes"]);
  e.purgeBackups(0);
  assert.deepEqual(fs.readdirSync(root).sort(), ["2026-10-20", "notes"]);
  fs.rmSync(root, { recursive: true });
  e.purgeBackups(); // no backups folder yet — no error
});

test("a broken edits.json is kept aside and the registry starts empty", (t) => {
  // protects=a corrupted registry does not crash the bridge and is not lost; fails_when=the constructor throws or overwrites the broken file; no_claim=recovering records from it
  const { data, edits } = setup(t);
  fs.mkdirSync(path.join(data, "office"), { recursive: true });
  fs.writeFileSync(path.join(data, "office", "edits.json"), "{ not json");
  const e = edits();
  assert.deepEqual(e.pending(), []);
  assert.deepEqual(fs.readdirSync(path.join(data, "office")), [`edits.json.bad-${NOW.getTime()}`]);
});
