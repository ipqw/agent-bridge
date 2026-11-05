// Control server for the bridge window: serves the UI and a small JSON API on 127.0.0.1.
// Auth: a per-start random token (handed to the Tauri shell on stdout), sent as a Bearer header
// or ?t= for the event stream. Only loopback Host and same-origin requests are accepted.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Route {
  method: string;
  path: RegExp;
  handler: (req: http.IncomingMessage, body: unknown, m: RegExpMatchArray) => Promise<unknown> | unknown;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export class ControlServer {
  readonly token = crypto.randomBytes(24).toString("base64url");
  private server?: http.Server;
  private streams = new Set<http.ServerResponse>();
  port = 0;

  constructor(
    private routes: Route[],
    private uiDir: string,
  ) {}

  async start(port: number): Promise<number> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as { port: number }).port;
    setInterval(() => this.broadcast("ping", {}), 25_000).unref();
    return this.port;
  }

  broadcast(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams) s.write(msg);
  }

  async stop() {
    for (const s of this.streams) s.end();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : (url.searchParams.get("t") ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    if (!url.pathname.startsWith("/api/")) return this.serveStatic(url.pathname, res);
    if (!this.authorized(req, url)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      this.streams.add(res);
      req.on("close", () => this.streams.delete(res));
      return;
    }
    const route = this.routes.find((r) => r.method === req.method && r.path.test(url.pathname));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    try {
      const body = req.method === "GET" ? undefined : await readJson(req);
      const out = await route.handler(req, body, url.pathname.match(route.path)!);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: msg }));
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse) {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = path.resolve(this.uiDir, rel);
    if (!file.startsWith(path.resolve(this.uiDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
