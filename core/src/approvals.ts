// Human approval queue. A request waits for the user's decision in the bridge window;
// no answer within the timeout means "deny".

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export interface ApprovalRequest {
  id: string;
  gate: string;
  title: string; // one line: the command / action
  details: string; // context for the human (screen tail, arguments)
  createdAt: string;
  expiresAt: string;
}

export type Decision = "approved" | "denied" | "timeout";

export class Approvals extends EventEmitter {
  private pending = new Map<string, { req: ApprovalRequest; resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  constructor(private timeoutSec: () => number) {
    super();
  }

  request(gate: string, title: string, details: string): Promise<Decision> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const ms = this.timeoutSec() * 1000;
    const req: ApprovalRequest = {
      id,
      gate,
      title,
      details,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ms).toISOString(),
    };
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.finish(id, "timeout"), ms);
      this.pending.set(id, { req, resolve, timer });
      this.emit("pending", req);
      this.emit("change");
    });
  }

  decide(id: string, approve: boolean): boolean {
    return this.finish(id, approve ? "approved" : "denied");
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, "denied");
  }

  private finish(id: string, d: Decision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(d);
    this.emit("change");
    return true;
  }
}
