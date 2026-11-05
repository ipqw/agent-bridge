// Registry of the agent's working copies and agent-created files (<dataDir>/office/edits.json),
// client review of copies (propose → replace / cancel) and backups (<dataDir>/backups/<date>/).
// "Replace" rewrites the original in place: same file, same file id, backup first.

import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";

export type EditStatus = "editing" | "pending" | "replaced" | "cancelled";
export interface EditRecord {
  id: string;
  original: string;
  copy: string;
  originalSha256: string;
  createdAt: string;
  status: EditStatus;
  summary?: string;
  proposedAt?: string;
  decidedAt?: string;
  backup?: string;
}
export type ReplaceResult =
  | { result: "replaced"; backup: string }
  | { result: "stale" } // original changed after the copy was made — needs force after the D6 card
  | { result: "locked"; message: string } // «Закройте файл в Excel и нажмите снова»
  | { result: "busy" } // a replace of this record (or of the same original) is already running
  | { result: "gone"; message: string }; // copy/original missing, or the record is not on review

const RecordSchema = z.object({
  id: z.string(),
  original: z.string(),
  copy: z.string(),
  originalSha256: z.string(),
  createdAt: z.string(),
  status: z.enum(["editing", "pending", "replaced", "cancelled"]),
  summary: z.string().optional(),
  proposedAt: z.string().optional(),
  decidedAt: z.string().optional(),
  backup: z.string().optional(),
});
const RegistrySchema = z.object({
  edits: z.array(RecordSchema).default([]),
  agentFiles: z.array(z.string()).default([]),
});

const COPY_MARK = "правки агента";
const CHUNK = 1 << 20;
// Windows: a file held open by Excel/Word gives EBUSY (sharing violation); EPERM/EACCES — read-only or denied.
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function appName(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if ([".xls", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".csv"].includes(ext)) return "Excel";
  if ([".doc", ".docx", ".docm", ".dotx", ".dotm", ".rtf"].includes(ext)) return "Word";
  if ([".ppt", ".pptx", ".pptm", ".ppsx", ".potx"].includes(ext)) return "PowerPoint";
  return null;
}

// Client-facing text for a file that cannot be opened for writing, or null if the error is not a lock.
async function lockedMessage(file: string, e: unknown, isCopy: boolean): Promise<string | null> {
  if (!LOCK_CODES.has(errCode(e) ?? "")) return null;
  const st = await fsp.stat(file).catch(() => null);
  if (st && (st.mode & 0o200) === 0)
    return `Файл «${path.basename(file)}» только для чтения — снимите «Только чтение» в его свойствах и нажмите снова`;
  const app = appName(file);
  if (isCopy) return app ? `Закройте копию в ${app} и нажмите снова` : "Закройте копию в программе, где она открыта, и нажмите снова";
  return app ? `Закройте файл в ${app} и нажмите снова` : "Закройте файл в программе, где он открыт, и нажмите снова";
}

function sha256Sync(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let n; (n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let pos = 0; ; ) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

// Copy all bytes of src (from offset 0) into dst starting at offset 0.
async function pump(src: FileHandle, dst: FileHandle): Promise<void> {
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; ; ) {
    const { bytesRead } = await src.read(buf, 0, CHUNK, pos);
    if (!bytesRead) return;
    for (let off = 0; off < bytesRead; ) {
      const { bytesWritten } = await dst.write(buf, off, bytesRead - off, pos + off);
      off += bytesWritten;
    }
    pos += bytesRead;
  }
}

async function isFile(p: string): Promise<boolean> {
  return (await fsp.stat(p).catch(() => null))?.isFile() ?? false;
}

// Create a new file <dir>/<name>, or «Имя (2).ext», «(3)»… if taken; never overwrites.
async function createFree(dir: string, name: string): Promise<{ file: string; fh: FileHandle }> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      return { file, fh: await fsp.open(file, "wx", 0o600) };
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
  }
  throw new Error(`Слишком много файлов с именем «${name}» в ${dir}`);
}

export class Edits extends EventEmitter {
  private file: string;
  private now: () => Date;
  private windows: boolean;
  private edits: EditRecord[] = [];
  private agentFiles: string[] = [];
  private busy = new Set<string>(); // record ids and "original:<key>" with a replace/cancel in flight

  constructor(private dataDir: string, o: { now?: () => Date; windows?: boolean } = {}) {
    super();
    this.now = o.now ?? (() => new Date());
    this.windows = o.windows ?? process.platform === "win32";
    this.file = path.join(dataDir, "office", "edits.json");
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    if (raw !== undefined) {
      try {
        const reg = RegistrySchema.parse(JSON.parse(raw));
        this.edits = reg.edits;
        this.agentFiles = reg.agentFiles;
      } catch {
        // keep a broken registry aside for inspection instead of failing the whole bridge
        fs.renameSync(this.file, `${this.file}.bad-${this.now().getTime()}`);
      }
    }
  }

  copy(original: string): EditRecord {
    const abs = path.resolve(original);
    if (this.activeByCopy(abs)) throw new Error("Это уже рабочая копия агента — правьте её, новая копия не нужна");
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`Файл не найден: ${abs}`);
    }
    if (!st.isFile()) throw new Error(`Это не файл: ${abs}`);
    const sha = sha256Sync(abs);
    const { dir, name, ext } = path.parse(abs);
    for (let n = 1; n < 1000; n++) {
      const copy = path.join(dir, `${name} (${COPY_MARK}${n === 1 ? "" : " " + n})${ext}`);
      try {
        fs.copyFileSync(abs, copy, fs.constants.COPYFILE_EXCL);
      } catch (e) {
        if (errCode(e) === "EEXIST") continue;
        throw e;
      }
      // the recorded hash must describe exactly the bytes the copy was made from
      if (sha256Sync(copy) !== sha) {
        fs.rmSync(copy, { force: true });
        throw new Error("Оригинал меняется прямо сейчас — повторите через минуту");
      }
      const rec: EditRecord = {
        id: crypto.randomUUID(),
        original: abs,
        copy,
        originalSha256: sha,
        createdAt: this.now().toISOString(),
        status: "editing",
      };
      this.edits.push(rec);
      try {
        this.save();
      } catch (e) {
        this.edits.pop();
        fs.rmSync(copy, { force: true });
        throw e;
      }
      this.emit("change");
      return { ...rec };
    }
    throw new Error("Рядом слишком много копий этого файла — уберите лишние");
  }

  registerAgentFiles(paths: string[]): void {
    const have = new Set(this.agentFiles.map((f) => this.key(f)));
    // an original under review never becomes freely writable
    for (const r of this.edits) have.add(this.key(r.original));
    let added = false;
    for (const p of paths) {
      const abs = path.resolve(p);
      const k = this.key(abs);
      if (have.has(k)) continue;
      have.add(k);
      this.agentFiles.push(abs);
      added = true;
    }
    if (!added) return;
    this.save();
    this.emit("change");
  }

  isAgentEditable(p: string): boolean {
    const k = this.key(p);
    return !!this.activeByCopy(p) || this.agentFiles.some((f) => this.key(f) === k);
  }

  writable(): string[] {
    const copies = this.edits.filter((r) => r.status === "editing" || r.status === "pending").map((r) => r.copy);
    return [...copies, ...this.agentFiles];
  }

  propose(copyPath: string, summary: string): EditRecord {
    const rec = this.lastBy(copyPath, false);
    if (!rec) throw new Error(`Это не рабочая копия агента: ${path.resolve(copyPath)}. Сначала office_copy, правки — в копии`);
    if (rec.status !== "editing" && rec.status !== "pending")
      throw new Error("Правки по этой копии уже закрыты: клиент заменил оригинал или отменил их");
    if (!fs.existsSync(rec.copy)) throw new Error(`Копия не найдена: ${rec.copy}`);
    rec.status = "pending";
    rec.summary = summary.slice(0, 2000);
    rec.proposedAt = this.now().toISOString();
    this.save();
    this.emit("change");
    return { ...rec };
  }

  statusOf(p: string): EditStatus | null {
    return this.lastBy(p, true)?.status ?? null;
  }

  pending(): EditRecord[] {
    return this.edits.filter((r) => r.status === "pending").map((r) => ({ ...r }));
  }

  get(id: string): EditRecord | undefined {
    const r = this.edits.find((e) => e.id === id);
    return r && { ...r };
  }

  async replace(id: string, o: { force?: boolean } = {}): Promise<ReplaceResult> {
    const rec = this.edits.find((e) => e.id === id);
    if (!rec || rec.status !== "pending")
      return {
        result: "gone",
        message: rec?.status === "editing" ? "Агент ещё не отдал эти правки на проверку" : "Эти правки уже закрыты",
      };
    const origKey = "original:" + this.key(rec.original);
    // checked and marked synchronously: a second click cannot slip in before the first await
    if (this.busy.has(id) || this.busy.has(origKey)) return { result: "busy" };
    this.busy.add(id);
    this.busy.add(origKey);
    try {
      return await this.replaceInPlace(rec, o.force === true);
    } finally {
      this.busy.delete(id);
      this.busy.delete(origKey);
    }
  }

  private async replaceInPlace(rec: EditRecord, force: boolean): Promise<ReplaceResult> {
    if (!(await isFile(rec.copy)))
      return { result: "gone", message: "Копия с правками не найдена — возможно, её удалили или переместили" };
    if (!(await isFile(rec.original)))
      return { result: "gone", message: "Оригинал не найден — возможно, его удалили или переместили" };

    // (b) the original changed after the copy was made (D6)
    let sha: string;
    try {
      sha = await sha256File(rec.original);
    } catch (e) {
      const m = await lockedMessage(rec.original, e, false);
      if (m) return { result: "locked", message: m };
      throw e;
    }
    if (sha !== rec.originalSha256 && !force) return { result: "stale" };

    // (c) open both without re-creating: the original stays the same file (id, attributes, streams)
    let orig: FileHandle | undefined;
    let copy: FileHandle | undefined;
    let backup: string;
    try {
      try {
        orig = await fsp.open(rec.original, "r+");
      } catch (e) {
        const m = await lockedMessage(rec.original, e, false);
        if (m) return { result: "locked", message: m };
        throw e;
      }
      try {
        copy = await fsp.open(rec.copy, "r+"); // r+ also detects the copy held open in Excel
      } catch (e) {
        const m = await lockedMessage(rec.copy, e, true);
        if (m) return { result: "locked", message: m };
        throw e;
      }

      // (d) backup of the original first, read through our own handle (CopyFile may hit a sharing violation)
      const b = await createFree(path.join(this.dataDir, "backups", localDate(this.now())), path.basename(rec.original));
      backup = b.file;
      try {
        await pump(orig, b.fh);
        await b.fh.sync();
      } catch (e) {
        await b.fh.close().catch(() => {});
        await fsp.rm(backup, { force: true });
        throw e;
      }
      await b.fh.close();

      // (e) the copy's bytes into the same handle
      try {
        await orig.truncate(0);
        await pump(copy, orig);
        await orig.sync();
      } catch (e) {
        await this.restore(orig, backup).catch(() => {});
        throw e;
      }
    } finally {
      await copy?.close().catch(() => {});
      await orig?.close().catch(() => {});
    }

    // (f) the original now holds the edits; a leftover copy is only clutter
    await fsp.rm(rec.copy, { force: true }).catch(() => {});
    rec.status = "replaced";
    rec.decidedAt = this.now().toISOString();
    rec.backup = backup;
    this.save();
    this.emit("change");
    return { result: "replaced", backup };
  }

  // Best effort after a failed write: put the backed-up bytes back into the original.
  private async restore(orig: FileHandle, backup: string): Promise<void> {
    const src = await fsp.open(backup, "r");
    try {
      await orig.truncate(0);
      await pump(src, orig);
      await orig.sync();
    } finally {
      await src.close();
    }
  }

  async cancel(id: string): Promise<{ ok: boolean; message?: string }> {
    const rec = this.edits.find((e) => e.id === id);
    if (!rec) return { ok: false, message: "Правки не найдены" };
    if (rec.status !== "editing" && rec.status !== "pending") return { ok: false, message: "Эти правки уже закрыты" };
    if (this.busy.has(id)) return { ok: false, message: "Замена оригинала уже идёт" };
    this.busy.add(id);
    try {
      let message: string | undefined;
      if (await isFile(rec.copy)) {
        const moved = await this.moveToBackups(rec.copy);
        if ("locked" in moved) return { ok: false, message: moved.locked };
        rec.backup = moved.file;
      } else {
        message = "Копии уже нет — правки закрыты";
      }
      rec.status = "cancelled";
      rec.decidedAt = this.now().toISOString();
      this.save();
      this.emit("change");
      return message ? { ok: true, message } : { ok: true };
    } finally {
      this.busy.delete(id);
    }
  }

  private async moveToBackups(file: string): Promise<{ file: string } | { locked: string }> {
    const b = await createFree(path.join(this.dataDir, "backups", localDate(this.now())), path.basename(file));
    await b.fh.close(); // the empty file reserves the name; rename replaces it
    try {
      await fsp.rename(file, b.file);
      return { file: b.file };
    } catch (e) {
      if (errCode(e) === "EXDEV") {
        // another disk (dataDir is on C:, allowed folders may be elsewhere): copy, then remove
        try {
          await fsp.copyFile(file, b.file);
          await fsp.unlink(file);
          return { file: b.file };
        } catch (e2) {
          await fsp.rm(b.file, { force: true });
          const m = await lockedMessage(file, e2, true);
          if (m) return { locked: m };
          throw e2;
        }
      }
      await fsp.rm(b.file, { force: true });
      const m = await lockedMessage(file, e, true);
      if (m) return { locked: m };
      throw e;
    }
  }

  purgeBackups(maxAgeDays = 30): void {
    const dir = path.join(this.dataDir, "backups");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const n = this.now();
    const cutoff = localDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() - maxAgeDays));
    for (const name of names)
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }

  private key(p: string): string {
    const abs = path.resolve(p);
    return this.windows ? abs.toLowerCase() : abs;
  }

  private activeByCopy(p: string): EditRecord | undefined {
    const r = this.lastBy(p, false);
    return r && (r.status === "editing" || r.status === "pending") ? r : undefined;
  }

  // Latest record whose copy (or, with originals, also original) is this path.
  private lastBy(p: string, originals: boolean): EditRecord | undefined {
    const k = this.key(p);
    for (let i = this.edits.length - 1; i >= 0; i--) {
      const r = this.edits[i];
      if (this.key(r.copy) === k || (originals && this.key(r.original) === k)) return r;
    }
    return undefined;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ edits: this.edits, agentFiles: this.agentFiles }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
