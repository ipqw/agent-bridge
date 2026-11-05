// Reconstruct the command line that Enter would submit, from a terminal-mcp text screenshot.

import os from "node:os";
import type { ShellKind } from "./allowlist.js";

export interface Screenshot {
  content: string;
  cursor: { x: number; y: number };
  dimensions: { cols: number; rows: number };
}

export interface PendingLine {
  command: string; // what follows the prompt (joined across wrapped / continuation rows)
  cwd: string | null; // parsed from the prompt when it carries one
  promptRecognized: boolean; // false => cursor is not at a shell prompt we know (e.g. inside a program)
  multiline: boolean; // continuation rows (">> ") were involved
  screenTail: string; // last rows of the screen, for the human
}

const PS_PROMPT = /^PS ([A-Za-z]:\\[^>]*|[^>]*)> ?/;
// terminal-mcp prefixes the bash/zsh prompt with a "⚡ mcp" marker; PS1 is the usual user@host:dir$
const POSIX_PROMPT = /^\s*(?:⚡ mcp\s+)?(?:[\w.-]+@[\w.-]+:)?(~?[^\s$#]*)[$#] /;
const PS_CONT = /^>> ?/;

export function parseScreen(shot: Screenshot, shell: ShellKind): PendingLine {
  const rows = shot.content.split("\n");
  const cols = shot.dimensions.cols;
  const y = Math.min(Math.max(shot.cursor.y, 0), rows.length - 1);
  const screenTail = rows
    .slice(Math.max(0, y - 9), y + 1)
    .map((r) => r.replace(/\s+$/, ""))
    .join("\n");

  // Walk up from the cursor row: wrapped rows (previous row filled to the last column) and
  // PowerShell continuation rows belong to the same submission.
  let start = y;
  let multiline = false;
  for (;;) {
    const row = rows[start] ?? "";
    if (matchPrompt(row, shell)) break;
    const prev = rows[start - 1];
    if (prev === undefined) break;
    if (prev.length >= cols) {
      start--;
      continue;
    }
    if (shell === "powershell" && PS_CONT.test(row)) {
      multiline = true;
      start--;
      continue;
    }
    break;
  }

  const first = rows[start] ?? "";
  const prompt = matchPrompt(first, shell);
  let command = "";
  for (let i = start; i <= y; i++) {
    let row = rows[i] ?? "";
    if (i === start && prompt) row = row.slice(prompt.length);
    else if (shell === "powershell" && PS_CONT.test(row) && !((rows[i - 1] ?? "").length >= cols)) {
      row = "\n" + row.replace(PS_CONT, "");
    }
    command += row;
  }
  return {
    command: command.replace(/\s+$/, ""),
    cwd: prompt?.cwd ?? null,
    promptRecognized: !!prompt,
    multiline,
    screenTail,
  };
}

function matchPrompt(row: string, shell: ShellKind): { length: number; cwd: string | null } | null {
  if (shell === "powershell") {
    const m = row.match(PS_PROMPT);
    if (m) return { length: m[0].length, cwd: /^[A-Za-z]:\\/.test(m[1]) ? m[1] : null };
    return null;
  }
  const m = row.match(POSIX_PROMPT);
  if (!m) return null;
  const dir = m[1];
  const cwd = dir.startsWith("/") ? dir : dir === "~" || dir.startsWith("~/") ? os.homedir() + dir.slice(1) : null;
  return { length: m[0].length, cwd };
  return null;
}
