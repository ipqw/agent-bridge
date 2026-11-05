// Append-only action journal (JSONL): every gated call and its outcome.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export interface JournalEntry {
  ts: string;
  gate: string; // terminal | browser | system
  action: string; // tool name or event
  summary: string;
  outcome: "auto" | "approved" | "denied" | "timeout" | "blocked" | "info" | "error";
  reason?: string;
}

export class Journal extends EventEmitter {
  private file: string;
  private recent: JournalEntry[] = [];
  constructor(dir: string, private keep = 500) {
    super();
    this.file = path.join(dir, "journal.jsonl");
    try {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").slice(-keep);
      this.recent = lines.filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      /* no journal yet */
    }
  }
  add(e: Omit<JournalEntry, "ts">): JournalEntry {
    const entry = { ts: new Date().toISOString(), ...e, summary: e.summary.slice(0, 2000) };
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    this.recent.push(entry);
    if (this.recent.length > this.keep) this.recent.shift();
    this.emit("entry", entry);
    return entry;
  }
  tail(n = 200): JournalEntry[] {
    return this.recent.slice(-n);
  }
}
