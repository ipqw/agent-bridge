// MCP gate: a Streamable-HTTP MCP server on 127.0.0.1 that fronts one local stdio MCP server,
// or none: without a child the policy's own tools are the whole surface (bridge-native tools).
// Every tools/call passes through a policy (allowlist + human approval) before it reaches the child.
// The gate is what frpc exposes over stcp; the child is never reachable directly.

import http from "node:http";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type Verdict =
  | { action: "forward"; args?: Record<string, unknown> }
  | { action: "result"; result: CallToolResult };

// Per-call context. `signal` aborts when the agent drops the HTTP request.
export interface CallContext {
  signal: AbortSignal;
}

export interface Policy {
  // Tools the agent may see (and with which descriptions). Without a child: tools([]).
  tools(childTools: Tool[]): Tool[];
  // Decide on one call. May call the child itself (e.g. to read the screen) via `child`.
  // Without a child the policy answers every call itself; "forward" becomes an error.
  decide(name: string, args: Record<string, unknown>, child: ChildHandle, ctx?: CallContext): Promise<Verdict>;
  // Post-process a forwarded result (size caps etc.).
  after?(name: string, result: CallToolResult): CallToolResult;
  // Called once each time the child (re)starts.
  onChildStart?(child: ChildHandle): Promise<void>;
  instructions?: string;
}

export interface ChildSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ChildHandle {
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface GateOptions {
  name: string;
  port: number;
  host?: string;
  token: () => string | null; // bearer the agent side must present; null = no token configured
  child?: ChildSpec; // none = tools are the policy's own, no process is spawned
  policy: Policy;
  log?: (msg: string) => void;
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Handed to policies of a gate without a child: there is nothing to call.
const NO_CHILD: ChildHandle = {
  call: async (name) => {
    throw new Error(`no child MCP to call ${name}`);
  },
};

export class Gate {
  private server?: http.Server;
  private client?: Client;
  private connecting?: Promise<Client>;
  private stopped = false;
  private backoffMs = 500;
  status: "starting" | "up" | "down" = "starting";
  lastError = "";

  constructor(private o: GateOptions) {}

  private log(m: string) {
    this.o.log?.(`[gate:${this.o.name}] ${m}`);
  }

  async start(): Promise<void> {
    if (this.o.child) await this.child();
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.o.port, this.o.host ?? "127.0.0.1", () => resolve());
    });
    if (!this.o.child) this.status = "up";
    this.log(`listening on ${this.o.host ?? "127.0.0.1"}:${this.o.port}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
    await this.client?.close().catch(() => {});
    this.status = "down";
  }

  // Lazily (re)connect to the child; one child process is shared by all agent sessions.
  private child(): Promise<Client> {
    const spec = this.o.child;
    if (!spec) return Promise.reject(new Error("gate has no child"));
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...(process.env as Record<string, string>), ...spec.env },
        cwd: spec.cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (d: Buffer) => this.log(`child: ${d.toString().trim().slice(0, 500)}`));
      const client = new Client({ name: `agent-bridge-${this.o.name}`, version: "0.1.0" });
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
        this.status = "down";
        if (!this.stopped) {
          this.log(`child exited, restarting in ${this.backoffMs} ms`);
          setTimeout(() => void this.child().catch(() => {}), this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        }
      };
      try {
        await client.connect(transport);
      } catch (e) {
        this.lastError = String(e);
        this.status = "down";
        throw e;
      }
      this.client = client;
      this.status = "up";
      this.backoffMs = 500;
      await this.o.policy.onChildStart?.(this.handle_(client)).catch((e) => this.log(`onChildStart: ${e}`));
      return client;
    })().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private handle_(client: Client): ChildHandle {
    return {
      call: async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    };
  }

  private checkRequest(req: http.IncomingMessage): string | null {
    // DNS-rebinding / browser protection: only loopback Host, and no browser Origin at all.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return "bad host";
    if (req.headers.origin) return "browser origin not allowed";
    const token = this.o.token();
    if (token) {
      const auth = req.headers.authorization ?? "";
      const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
      const want = Buffer.from(token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return "unauthorized";
    }
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const deny = this.checkRequest(req);
    if (deny) {
      res.writeHead(deny === "unauthorized" ? 401 : 403, { "content-type": "application/json" }).end(JSON.stringify({ error: deny }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless gate: no server-initiated stream, no sessions to delete.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    // Stateless: a fresh MCP server per request, so a bridge restart never strands an agent session.
    const server = this.mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      this.log(`request failed: ${e}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private mcpServer(): Server {
    const server = new Server(
      { name: `agent-bridge-${this.o.name}`, version: "0.1.0" },
      { capabilities: { tools: {} }, instructions: this.o.policy.instructions },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.o.child) return { tools: this.o.policy.tools([]) };
      const client = await this.child();
      const { tools } = await client.listTools();
      return { tools: this.o.policy.tools(tools) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      // extra.signal aborts when the transport closes, i.e. when the agent drops the HTTP request.
      const ctx: CallContext = { signal: extra.signal };
      if (!this.o.child) {
        const verdict = await this.o.policy.decide(name, args, NO_CHILD, ctx);
        if (verdict.action === "result") return verdict.result;
        return errorResult(`Мост: инструмент «${name}» недоступен — у гейта «${this.o.name}» нет локального MCP.`);
      }
      let client: Client;
      try {
        client = await this.child();
      } catch (e) {
        return errorResult(`Мост: локальный MCP «${this.o.name}» не запущен (${e}).`);
      }
      const verdict = await this.o.policy.decide(name, args, this.handle_(client), ctx);
      if (verdict.action === "result") return verdict.result;
      const result = (await client.callTool({ name, arguments: verdict.args ?? args })) as CallToolResult;
      return this.o.policy.after ? this.o.policy.after(name, result) : result;
    });
    return server;
  }
}
