// Policy for terminal-mcp (a PTY emulator: the agent types text and presses keys).
// A command only runs when a submit key reaches the shell, so the gate sits on submit keys:
// it reconstructs the pending line from the screen, auto-approves allowlisted read-only
// commands, and asks the human for everything else. A refused line is cancelled with Ctrl+C.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { checkCommandLine, taintsSession, type ShellKind } from "../allowlist.js";
import { parseScreen, type PendingLine, type Screenshot } from "../screen.js";
import { errorResult, type ChildHandle, type Policy, type Verdict } from "../gate.js";
import type { Approvals, Decision } from "../approvals.js";
import type { Journal } from "../journal.js";

// Keys that edit or move within the line but cannot submit it.
const SAFE_KEYS = new Set(
  [
    "tab", "escape", "backspace", "delete",
    "arrowup", "arrowdown", "arrowleft", "arrowright",
    "home", "end", "pageup", "pagedown", "insert",
    "ctrl+a", "ctrl+b", "ctrl+c", "ctrl+e", "ctrl+f", "ctrl+h", "ctrl+i", "ctrl+k",
    "ctrl+l", "ctrl+u", "ctrl+w", "ctrl+space",
  ],
);

const EXPOSED = new Set(["type", "sendKey", "getContent", "takeScreenshot", "createSession", "listSessions", "destroySession"]);
const MAX_CONTENT = 64 * 1024;
// Control characters (except Tab), DEL, and invisible / bidi code points are refused in typed text:
// typed text must never submit a line by itself, and the human must see what will run.
const BAD_TEXT = /[\u0000-\u0008\u000a-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/;

const PS_INIT =
  'try { Set-PSReadLineOption -PredictionSource None } catch {}; function global:prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }; Clear-Host';

export interface TerminalPolicyOptions {
  shell: string;
  folders: () => string[];
  autoAllow: () => boolean;
  approvals: Approvals;
  journal: Journal;
}

interface SessionState {
  typed: string; // text typed since the last submit
  edited: boolean; // editing keys (Tab, arrows, Backspace…) were used since the last submit
  keys: string[]; // keystroke log since the last submit, shown to the human
  tainted: boolean; // an approved command redefined how commands resolve
  busy: boolean; // a submit is being decided: no other input until it is done
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY = errorResult("Bridge: the previous line is waiting for the user's approval — wait for that call to return.");

export function shellKind(shell: string): ShellKind {
  return /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shell) ? "powershell" : "posix";
}

export class TerminalPolicy implements Policy {
  private sessions = new Map<string, SessionState>();
  private kind: ShellKind;
  instructions =
    "Terminal on the user's computer, behind the Agent Bridge. Enter (and any other submit key) is gated: " +
    "allowlisted read-only commands inside the user's allowed folders run at once; everything else waits for the " +
    "user's approval in the bridge window and is cancelled (Ctrl+C) if refused or not answered in time. " +
    "Type one simple command per line; avoid pipes and chaining when a plain command will do.";

  constructor(private o: TerminalPolicyOptions) {
    this.kind = shellKind(o.shell);
  }

  private state(id: unknown): SessionState {
    const key = typeof id === "string" && id ? id : "default";
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = { typed: "", edited: false, keys: [], tainted: false, busy: false }));
    return s;
  }

  tools(childTools: Tool[]): Tool[] {
    return childTools
      .filter((t) => EXPOSED.has(t.name))
      .map((t) => {
        if (t.name === "createSession") {
          const props = { ...(t.inputSchema.properties ?? {}) };
          delete props.shell;
          return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
        }
        if (t.name === "sendKey")
          return { ...t, description: `${t.description} Bridge: Enter and other submit keys wait for allowlist or user approval.` };
        if (t.name === "type")
          return { ...t, description: `${t.description} Bridge: control characters (newline etc.) are refused — submit with sendKey('Enter').` };
        return t;
      });
  }

  async onChildStart(child: ChildHandle): Promise<void> {
    this.sessions.clear();
    await child.call("getContent", { visibleOnly: true }); // creates the default session
    await this.initSession(child, undefined);
  }

  private async initSession(child: ChildHandle, sessionId: string | undefined) {
    if (this.kind !== "powershell") return;
    const sid = sessionId ? { sessionId } : {};
    await child.call("type", { text: PS_INIT, ...sid });
    await child.call("sendKey", { key: "Enter", ...sid });
  }

  async decide(name: string, args: Record<string, unknown>, child: ChildHandle): Promise<Verdict> {
    if (!EXPOSED.has(name)) {
      this.o.journal.add({ gate: "terminal", action: name, summary: "tool not exposed", outcome: "blocked" });
      return { action: "result", result: errorResult(`Bridge: tool "${name}" is not available.`) };
    }
    const st = this.state(args.sessionId);
    switch (name) {
      case "type": {
        if (st.busy) return { action: "result", result: BUSY };
        const text = String(args.text ?? "");
        if (BAD_TEXT.test(text)) {
          this.o.journal.add({ gate: "terminal", action: "type", summary: JSON.stringify(text), outcome: "blocked", reason: "control characters" });
          return { action: "result", result: errorResult("Bridge: control characters are not allowed in typed text. Type the command, then sendKey('Enter').") };
        }
        st.typed += text;
        st.keys.push(JSON.stringify(text));
        return { action: "forward" };
      }
      case "sendKey": {
        if (st.busy) return { action: "result", result: BUSY };
        const key = String(args.key ?? "").trim();
        if (SAFE_KEYS.has(key.toLowerCase())) {
          if (key.toLowerCase() === "ctrl+c") {
            // cancels the line at a prompt: start over
            st.typed = "";
            st.edited = false;
            st.keys = [];
          } else {
            st.edited = true;
            st.keys.push(`<${key}>`);
          }
          return { action: "forward" };
        }
        st.busy = true;
        try {
          return await this.submit(key, args, st, child);
        } finally {
          st.busy = false;
          st.typed = "";
          st.edited = false;
          st.keys = [];
        }
      }
      case "createSession": {
        const { shell: _ignored, ...rest } = args;
        const result = await child.call("createSession", rest);
        const id = sessionIdOf(result);
        if (id) await this.initSession(child, id);
        this.o.journal.add({ gate: "terminal", action: "createSession", summary: id ?? "?", outcome: "info" });
        return { action: "result", result };
      }
      default:
        return { action: "forward" };
    }
  }

  // Read the pending line once the screen has caught up with what the agent typed.
  private async readLine(child: ChildHandle, sid: Record<string, string>, st: SessionState): Promise<PendingLine | null> {
    const read = async () => {
      const shot = parseShot(await child.call("takeScreenshot", { format: "text", ...sid }));
      return shot ? parseScreen(shot, this.kind) : null;
    };
    let line = await read();
    let prev = JSON.stringify(line);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (line && !st.edited && line.command.trim() === st.typed.trim()) return line;
      await sleep(50);
      const next = await read();
      const cur = JSON.stringify(next);
      if (st.edited && cur === prev) return next; // edited lines: wait until the screen is stable
      line = next;
      prev = cur;
    }
    return line;
  }

  private async submit(key: string, args: Record<string, unknown>, st: SessionState, child: ChildHandle): Promise<Verdict> {
    const sid: Record<string, string> = typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {};
    const line = await this.readLine(child, sid, st);
    const isEnter = key.toLowerCase() === "enter";
    const keys = [...st.keys, `<${key}>`];
    const send = async (): Promise<Verdict> => ({ action: "result", result: await child.call("sendKey", { key, ...sid }) });

    let reason = "";
    if (!line) reason = "screen unreadable";
    else if (!isEnter) reason = `key ${key} may submit the line`;
    else if (!line.promptRecognized) reason = "not at a known shell prompt (a program may be waiting for input)";
    else if (line.multiline) reason = "multi-line input";
    else if (st.edited) reason = "the line was edited with keys (Tab, arrows, Backspace…)";
    else if (line.command.trim() !== st.typed.trim()) reason = "the screen does not show exactly what the agent typed";
    else if (st.tainted) reason = "session redefined commands earlier — auto-approval is off for it";
    else if (!this.o.autoAllow()) reason = "auto-approval is off";
    else {
      const verdict = checkCommandLine(line.command, {
        shell: this.kind,
        cwd: line.cwd,
        folders: this.o.folders(),
        windows: this.kind === "powershell" || process.platform === "win32",
      });
      if (verdict.ok) {
        this.o.journal.add({ gate: "terminal", action: "submit", summary: line.command, outcome: "auto" });
        return send();
      }
      reason = verdict.reason;
    }

    const title = line && line.promptRecognized ? line.command || "(пустая строка)" : `${key} в запущенной программе`;
    const details = [
      `Почему спрашиваю: ${reason}`,
      line?.cwd ? `Папка: ${line.cwd}` : "",
      "Экран:",
      line?.screenTail ?? "",
      "Нажатия агента с прошлой отправки:",
      keys.join(" ").slice(-1500),
    ]
      .filter(Boolean)
      .join("\n");
    let decision: Decision | "changed" = await this.o.approvals.request("terminal", title, details);
    if (decision === "approved" && line?.promptRecognized) {
      // what runs must be what the human saw
      const now = await this.readLine(child, sid, { ...st, edited: true });
      if (!now || now.command !== line.command) decision = "changed";
    }
    if (decision === "approved") {
      if (line && taintsSession(line.command)) st.tainted = true;
      this.o.journal.add({ gate: "terminal", action: "submit", summary: title, outcome: "approved", reason });
      return send();
    }
    await child.call("sendKey", { key: "Ctrl+C", ...sid }).catch(() => {});
    this.o.journal.add({ gate: "terminal", action: "submit", summary: title, outcome: decision === "changed" ? "blocked" : decision, reason: decision === "changed" ? "line changed after the approval request" : reason });
    const why = decision === "timeout" ? "no answer from the user in time" : decision === "changed" ? "the line changed after the user saw it" : "the user refused";
    return {
      action: "result",
      result: errorResult(`Bridge: not executed — ${why}. The line was cancelled with Ctrl+C. (${reason})`),
    };
  }

  after(name: string, result: CallToolResult): CallToolResult {
    if (name !== "getContent") return result;
    return {
      ...result,
      content: result.content.map((c) => {
        if (c.type !== "text" || c.text.length <= MAX_CONTENT) return c;
        return { ...c, text: `[bridge: output truncated to the last ${MAX_CONTENT} chars]\n` + c.text.slice(-MAX_CONTENT) };
      }),
    };
  }
}

function textOf(r: CallToolResult): string {
  const c = r.content?.find((x) => x.type === "text");
  return c && c.type === "text" ? c.text : "";
}

function parseShot(r: CallToolResult): Screenshot | null {
  try {
    const j = JSON.parse(textOf(r));
    if (typeof j.content === "string" && j.cursor && j.dimensions) return j as Screenshot;
  } catch {
    /* not a screenshot */
  }
  return null;
}

function sessionIdOf(r: CallToolResult): string | undefined {
  try {
    const j = JSON.parse(textOf(r));
    return typeof j.sessionId === "string" ? j.sessionId : typeof j.id === "string" ? j.id : undefined;
  } catch {
    return undefined;
  }
}
