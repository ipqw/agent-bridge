const token = (() => {
  const m = location.hash.match(/t=([\w-]+)/);
  if (m) {
    try {
      sessionStorage.setItem("sb-token", m[1]);
    } catch {
      /* storage unavailable */
    }
    return m[1];
  }
  try {
    return sessionStorage.getItem("sb-token") ?? "";
  } catch {
    return "";
  }
})();

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export function events(onEvent: (type: string, data: unknown) => void): () => void {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  for (const t of ["state", "approvals", "journal"]) es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export type ToolMode = "auto" | "ask" | "deny";

export interface Config {
  clientId: string;
  frps: { addr: string; port: number; user: string };
  folders: string[];
  approvalTimeoutSec: number;
  control: { port: number };
  terminal: { enabled: boolean; port: number; shell: string; autoAllow: boolean };
  browser: { enabled: boolean; port: number; executablePath: string; profileDirName: string; tools: Record<string, ToolMode> };
  apps: { port: number; office: { enabled: boolean; trustScripts: boolean } };
}

export interface Approval {
  id: string;
  gate: string;
  title: string;
  details: string;
  createdAt: string;
  expiresAt: string;
}

export interface JournalEntry {
  ts: string;
  gate: string;
  action: string;
  summary: string;
  outcome: string;
  reason?: string;
}

export interface EditRecord {
  id: string;
  original: string;
  copy: string;
  status: "editing" | "pending" | "replaced" | "cancelled";
  summary?: string;
  proposedAt?: string;
}

export type ReplaceResult =
  | { result: "replaced"; backup: string }
  | { result: "stale" }
  | { result: "locked"; message: string }
  | { result: "busy" }
  | { result: "gone"; message: string };

export interface RuntimeState {
  state: "off" | "installing" | "ready" | "error";
  message: string;
  percent?: number;
}

export interface OfficeState {
  runtime: RuntimeState;
  detect: { office: { excel: boolean; word: boolean; powerpoint: boolean }; soffice: string | null } | null;
  libreOffice: { installed: boolean; soffice?: string; status: RuntimeState };
  libreOfficeOffer: boolean;
}

export interface State {
  version: string;
  dataDir: string;
  secretStore: string;
  config: Config;
  defaultBrowserTools: Record<string, ToolMode>;
  secretsSet: Record<string, boolean>;
  gates: Record<"terminal" | "browser" | "apps", { enabled: boolean; port: number; status: string; error: string }>;
  frpc: { state: string; problem: string; connected: boolean; proxies: string[]; logs: string[] };
  approvals: Approval[];
  office: OfficeState;
  edits: EditRecord[];
  autostart: { supported: boolean; mode: string; detail: string };
}
