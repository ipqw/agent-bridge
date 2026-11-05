// Static allowlist for auto-approving a terminal command line.
//
// Deny-by-default: a line is auto-approved only if it parses as ONE simple invocation of a
// known read-only command, with known parameters, no shell metacharacters, and every path
// argument resolving inside an allowed folder. Anything else goes to human approval.

import path from "node:path";
import fs from "node:fs";

export type ShellKind = "powershell" | "posix";

export interface AllowContext {
  shell: ShellKind;
  cwd: string | null; // from the prompt; null = unknown (relative paths then rejected)
  folders: string[]; // allowed roots (absolute)
  windows: boolean; // path semantics (case-insensitive, drive letters)
}

export type AllowResult = { ok: true; command: string } | { ok: false; reason: string };

type Positional = "path" | "value";

interface CmdSpec {
  names: string[];
  pathParams?: string[];
  valueParams?: string[];
  switches?: string[];
  positional?: Positional[]; // kinds of positional args in order
  restPositional?: Positional; // kind of extra positional args beyond `positional`
  noArgs?: boolean;
}

const PS_SPECS: CmdSpec[] = [
  {
    names: ["get-childitem", "gci", "ls", "dir"],
    pathParams: ["-path", "-literalpath"],
    valueParams: ["-filter", "-include", "-exclude", "-depth"],
    switches: ["-recurse", "-force", "-name", "-file", "-directory"],
    positional: ["path", "value"],
  },
  {
    names: ["get-content", "gc", "cat", "type"],
    pathParams: ["-path", "-literalpath"],
    valueParams: ["-tail", "-last", "-totalcount", "-head", "-first", "-encoding"],
    switches: ["-raw"],
    positional: ["path"],
  },
  { names: ["get-item", "gi"], pathParams: ["-path", "-literalpath"], switches: ["-force"], positional: ["path"] },
  { names: ["test-path"], pathParams: ["-path", "-literalpath"], valueParams: ["-pathtype"], positional: ["path"] },
  { names: ["resolve-path", "rvpa"], pathParams: ["-path", "-literalpath"], positional: ["path"] },
  {
    names: ["get-filehash"],
    pathParams: ["-path", "-literalpath"],
    valueParams: ["-algorithm"],
    positional: ["path"],
  },
  {
    names: ["select-string", "sls"],
    pathParams: ["-path", "-literalpath"],
    valueParams: ["-pattern", "-context", "-encoding"],
    switches: ["-simplematch", "-casesensitive", "-list", "-quiet", "-notmatch", "-allmatches"],
    positional: ["value", "path"],
  },
  { names: ["set-location", "cd", "sl", "chdir"], pathParams: ["-path", "-literalpath"], positional: ["path"] },
  { names: ["get-location", "pwd", "gl"], noArgs: true },
  { names: ["clear-host", "cls", "clear"], noArgs: true },
];

const POSIX_SPECS: CmdSpec[] = [
  { names: ["ls"], switches: ["-l", "-a", "-la", "-al", "-lh", "-lah", "-h", "-1", "-r", "-t", "-lt", "-ltr"], positional: [], restPositional: "path" },
  { names: ["cat", "wc", "stat", "file"], switches: ["-l", "-c", "-w", "-n"], positional: [], restPositional: "path" },
  { names: ["head", "tail"], valueParams: ["-n", "-c"], positional: [], restPositional: "path" },
  {
    names: ["grep"],
    switches: ["-i", "-n", "-r", "-l", "-c", "-v", "-e", "-f", "-w", "-rn", "-ri", "-rl", "-in"],
    positional: ["value"],
    restPositional: "path",
  },
  { names: ["cd"], positional: ["path"] },
  { names: ["pwd", "clear"], noArgs: true },
];

// Characters that make a line more than a single simple invocation (pipes, chaining, redirection,
// subexpressions, variables, escapes, arrays, comments, history expansion, wildcard ranges).
const PS_FORBIDDEN = /[;|&<>`$(){}\[\]@,#!%=\r\n\u0000-\u001f\u007f]/;
const POSIX_FORBIDDEN = /[;|&<>`$(){}\[\]@,#!%=\\~\r\n\u0000-\u001f\u007f]/;
// Invisible / direction-changing code points: what the human sees must be what runs.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

interface Token {
  text: string;
  quoted: boolean;
}

function tokenize(line: string, shell: ShellKind): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1);
      if (end < 0) return "unterminated quote";
      const body = line.slice(i + 1, end);
      if (ch === '"' && /[$`\\]/.test(body)) return "expansion inside double quotes";
      if (end + 1 < line.length && line[end + 1] !== " " && line[end + 1] !== "\t") return "quote glued to text";
      tokens.push({ text: body, quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== " " && line[j] !== "\t") {
      if (line[j] === "'" || line[j] === '"') return "quote inside word";
      j++;
    }
    tokens.push({ text: line.slice(i, j), quoted: false });
    i = j;
  }
  if (shell === "powershell" && tokens.some((t) => !t.quoted && t.text === "--%")) return "stop-parsing token";
  return tokens;
}

function stripForbiddenCheck(line: string, shell: ShellKind): string | null {
  if (INVISIBLE.test(line)) return "invisible characters";
  // Quoted segments are checked by the tokenizer; outside quotes nothing special is allowed.
  const outside = line.replace(/'[^']*'|"[^"]*"/g, "''");
  const re = shell === "powershell" ? PS_FORBIDDEN : POSIX_FORBIDDEN;
  const m = outside.match(re);
  if (m) return `forbidden character ${JSON.stringify(m[0])}`;
  return null;
}

function norm(p: string, windows: boolean): string {
  const n = windows ? path.win32.normalize(p) : path.posix.normalize(p);
  const trimmed = n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n) ? n.slice(0, -1) : n;
  return windows ? trimmed.toLowerCase() : trimmed;
}

function isInside(child: string, root: string, windows: boolean): boolean {
  const c = norm(child, windows);
  const r = norm(root, windows);
  if (c === r) return true;
  const sep = windows ? "\\" : "/";
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

// Resolve a path argument to an absolute path, or explain why it is not acceptable.
export function resolvePathArg(arg: string, ctx: AllowContext): { abs: string } | { reason: string } {
  const p = ctx.windows ? path.win32 : path.posix;
  if (arg === "") return { reason: "empty path" };
  if (ctx.windows) {
    if (/^[\\/]{2}/.test(arg)) return { reason: "UNC/device path" };
    if (/^~/.test(arg)) return { reason: "home shorthand" };
    // a colon is allowed only as a drive letter: rejects providers (Env:, HKLM:), ADS (file:stream)
    const colon = arg.indexOf(":");
    if (colon >= 0 && !(colon === 1 && /^[A-Za-z]:[\\/]/.test(arg)) ) return { reason: "provider/stream path" };
    if (arg.lastIndexOf(":") !== colon) return { reason: "provider/stream path" };
    if (/^[A-Za-z]:(?![\\/])/.test(arg)) return { reason: "drive-relative path" };
  }
  let abs: string;
  if (p.isAbsolute(arg) && (!ctx.windows || /^[A-Za-z]:[\\/]/.test(arg))) {
    abs = p.normalize(arg);
  } else if (ctx.windows && /^[\\/]/.test(arg)) {
    return { reason: "root-relative path" };
  } else {
    if (!ctx.cwd) return { reason: "relative path with unknown cwd" };
    abs = p.resolve(ctx.cwd, arg);
  }
  return { abs };
}

function hasWildcard(s: string): boolean {
  return /[*?]/.test(s);
}

// Follow symlinks/junctions for the part of the path that exists, so a link inside an allowed
// folder cannot point the command outside of it.
function realPathOrSelf(abs: string, windows: boolean): string {
  const p = windows ? path.win32 : path.posix;
  let probe = abs;
  const tail: string[] = [];
  for (let k = 0; k < 64; k++) {
    try {
      const real = fs.realpathSync.native(probe);
      return tail.length ? p.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = p.dirname(probe);
      if (parent === probe) return abs;
      tail.push(p.basename(probe));
      probe = parent;
    }
  }
  return abs;
}

export function checkPath(arg: string, ctx: AllowContext): string | null {
  const r = resolvePathArg(arg, ctx);
  if ("reason" in r) return r.reason;
  const p = ctx.windows ? path.win32 : path.posix;
  const segments = r.abs.split(/[\\/]/);
  // wildcards only in the last segment
  if (segments.slice(0, -1).some(hasWildcard)) return "wildcard in a directory segment";
  const base = hasWildcard(segments[segments.length - 1]) ? p.dirname(r.abs) : r.abs;
  // Compare resolved paths: follows links/junctions and maps 8.3 short names to long ones.
  const real = realPathOrSelf(base, ctx.windows);
  if (!ctx.folders.some((f) => isInside(real, realPathOrSelf(f, ctx.windows), ctx.windows)))
    return real === base ? `outside allowed folders: ${r.abs}` : `outside allowed folders: ${r.abs} -> ${real}`;
  return null;
}

function checkValue(v: string): string | null {
  if (v.length > 200) return "value too long";
  return null;
}

export function checkCommandLine(line: string, ctx: AllowContext): AllowResult {
  const command = line.trim();
  if (!command) return { ok: false, reason: "empty line" };
  if (command.length > 1000) return { ok: false, reason: "line too long" };
  const forbidden = stripForbiddenCheck(command, ctx.shell);
  if (forbidden) return { ok: false, reason: forbidden };
  const tokens = tokenize(command, ctx.shell);
  if (typeof tokens === "string") return { ok: false, reason: tokens };
  const [head, ...rest] = tokens;
  if (head.quoted) return { ok: false, reason: "quoted command name" };
  const specs = ctx.shell === "powershell" ? PS_SPECS : POSIX_SPECS;
  const name = ctx.shell === "powershell" ? head.text.toLowerCase() : head.text;
  const spec = specs.find((s) => s.names.includes(name));
  if (!spec) return { ok: false, reason: `command not in allowlist: ${head.text}` };
  if (spec.noArgs) return rest.length ? { ok: false, reason: "unexpected arguments" } : { ok: true, command };

  const caseFold = (s: string) => (ctx.shell === "powershell" ? s.toLowerCase() : s);
  let positionalIndex = 0;
  let sawPath = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.quoted && t.text.startsWith("-") && t.text.length > 1) {
      const param = caseFold(t.text);
      if (spec.switches?.includes(param)) continue;
      const isPath = spec.pathParams?.includes(param);
      const isValue = spec.valueParams?.includes(param);
      if (!isPath && !isValue) return { ok: false, reason: `parameter not allowed: ${t.text}` };
      const v = rest[++i];
      if (!v) return { ok: false, reason: `missing value for ${t.text}` };
      if (!v.quoted && v.text.startsWith("-")) return { ok: false, reason: `missing value for ${t.text}` };
      const err = isPath ? checkPath(v.text, ctx) : checkValue(v.text);
      if (err) return { ok: false, reason: err };
      if (isPath) sawPath = true;
      continue;
    }
    const kind = positionalIndex < (spec.positional?.length ?? 0) ? spec.positional![positionalIndex] : spec.restPositional;
    positionalIndex++;
    if (!kind) return { ok: false, reason: "too many arguments" };
    const err = kind === "path" ? checkPath(t.text, ctx) : checkValue(t.text);
    if (err) return { ok: false, reason: err };
    if (kind === "path") sawPath = true;
  }
  // No explicit path means "current directory": allowed only when the cwd itself is allowed.
  if (!sawPath && name !== "pwd") {
    const needsPath = (spec.positional ?? []).includes("path") || spec.restPositional === "path";
    if (needsPath) {
      if (["cd", "set-location", "sl", "chdir"].includes(name)) return { ok: false, reason: "cd without a path" };
      if (!ctx.cwd) return { ok: false, reason: "unknown cwd" };
      const err = checkPath(ctx.cwd, ctx);
      if (err) return { ok: false, reason: `cwd ${err}` };
    }
  }
  return { ok: true, command };
}

// Commands that change how later commands resolve (aliases, functions, modules, prompt):
// once the human approves one of these, the session is no longer trusted for auto-approval.
const TAINT = /\b(function|filter|set-alias|new-alias|sal|nal|alias:|function:|import-module|ipmo|add-type|invoke-expression|iex|set-psreadline\w*|executioncontext|prompt|alias|source|export|unalias|enable|builtin|bind)\b|^\s*\.\s/i;

export function taintsSession(line: string): boolean {
  return TAINT.test(line);
}
