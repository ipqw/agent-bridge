// Keeps one child process alive: spawn, collect output, restart with backoff on exit.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface SupervisedSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class Supervised extends EventEmitter {
  private proc?: ChildProcess;
  private stopped = true;
  private backoffMs = 1000;
  private timer?: NodeJS.Timeout;
  readonly logs: string[] = [];
  state: "stopped" | "running" | "restarting" = "stopped";

  constructor(private spec: SupervisedSpec) {
    super();
  }

  start() {
    this.stopped = false;
    this.spawnOnce();
  }

  private spawnOnce() {
    const s = this.spec;
    const p = spawn(s.command, s.args, {
      env: { ...process.env, ...s.env },
      cwd: s.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = p;
    this.state = "running";
    const startedAt = Date.now();
    const onData = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.push(line);
    };
    p.stdout?.on("data", onData);
    p.stderr?.on("data", onData);
    p.on("error", (e) => this.push(`spawn error: ${e.message}`));
    p.on("exit", (code, signal) => {
      this.push(`exited code=${code} signal=${signal}`);
      if (this.proc === p) this.proc = undefined;
      if (this.stopped) {
        this.state = "stopped";
        this.emit("change");
        return;
      }
      if (Date.now() - startedAt > 60_000) this.backoffMs = 1000;
      this.state = "restarting";
      this.emit("change");
      this.timer = setTimeout(() => this.spawnOnce(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    this.emit("change");
  }

  private push(raw: string) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (!line.trim()) return;
    this.logs.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (this.logs.length > 300) this.logs.shift();
    this.emit("log", line);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const p = this.proc;
    if (!p) {
      this.state = "stopped";
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill("SIGKILL");
        resolve();
      }, 3000);
      p.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      p.kill();
    });
  }

  async restart(spec?: SupervisedSpec) {
    await this.stop();
    if (spec) this.spec = spec;
    this.backoffMs = 1000;
    this.start();
  }
}
