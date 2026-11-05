// Policy for @playwright/mcp in --extension mode (drives the user's live Chrome/Brave/Edge).
// Per-tool mode from the GUI: auto | ask | deny; unknown tools ask.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type Policy, type Verdict } from "../gate.js";
import type { Approvals } from "../approvals.js";
import type { Journal } from "../journal.js";
import type { ToolMode } from "../config.js";

export interface BrowserPolicyOptions {
  mode: (tool: string) => ToolMode;
  approvals: Approvals;
  journal: Journal;
}

export class BrowserPolicy implements Policy {
  instructions =
    "The user's own live browser (their logged-in sessions), behind the Agent Bridge. Reading and navigating " +
    "http(s) pages runs at once; clicking, typing, uploads and scripts wait for the user's approval in the bridge window.";

  constructor(private o: BrowserPolicyOptions) {}

  tools(childTools: Tool[]): Tool[] {
    return childTools.filter((t) => this.o.mode(t.name) !== "deny");
  }

  async decide(name: string, args: Record<string, unknown>): Promise<Verdict> {
    let mode = this.o.mode(name);
    let reason = `tool mode: ${mode}`;
    // Non-web schemes (file:, chrome:, javascript:, data:) reach local files or browser internals.
    const url = typeof args.url === "string" ? args.url : null;
    if (url !== null && mode === "auto" && !/^https?:\/\//i.test(url)) {
      mode = "ask";
      reason = "not an http(s) URL";
    }
    const summary = `${name} ${JSON.stringify(args).slice(0, 500)}`;
    if (mode === "deny") {
      this.o.journal.add({ gate: "browser", action: name, summary, outcome: "blocked" });
      return { action: "result", result: errorResult(`Bridge: browser tool "${name}" is disabled by the user.`) };
    }
    if (mode === "auto") {
      this.o.journal.add({ gate: "browser", action: name, summary, outcome: "auto" });
      return { action: "forward" };
    }
    const decision = await this.o.approvals.request(
      "browser",
      describe(name, args),
      `Почему спрашиваю: ${reason}\nВызов: ${name}\nАргументы:\n${JSON.stringify(args, null, 2).slice(0, 3000)}`,
    );
    this.o.journal.add({ gate: "browser", action: name, summary, outcome: decision, reason });
    if (decision === "approved") return { action: "forward" };
    const why = decision === "timeout" ? "no answer from the user in time" : "the user refused";
    return { action: "result", result: errorResult(`Bridge: not executed — ${why}.`) };
  }
}

function describe(name: string, args: Record<string, unknown>): string {
  const el = typeof args.element === "string" ? ` «${args.element}»` : "";
  const url = typeof args.url === "string" ? ` ${args.url}` : "";
  const text = typeof args.text === "string" ? ` текст «${args.text.slice(0, 80)}»` : "";
  return `Браузер: ${name.replace(/^browser_/, "")}${el}${url}${text}`;
}
