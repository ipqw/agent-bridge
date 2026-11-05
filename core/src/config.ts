import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

export const ToolMode = z.enum(["auto", "ask", "deny"]);
export type ToolMode = z.infer<typeof ToolMode>;

// Browser tools that only read or navigate run without asking; everything that acts on a page
// (clicks, typing, uploads, scripts) asks. Tools not listed here ask as well (deny-by-default).
export const DEFAULT_BROWSER_TOOLS: Record<string, ToolMode> = {
  browser_navigate: "auto", // http(s) only — other schemes are forced to "ask" by the policy
  browser_navigate_back: "auto",
  browser_snapshot: "auto",
  browser_find: "auto",
  browser_take_screenshot: "auto",
  browser_tabs: "auto",
  browser_wait_for: "auto",
  browser_console_messages: "auto",
  browser_network_requests: "auto",
  browser_network_request: "auto",
  browser_click: "ask",
  browser_type: "ask",
  browser_fill_form: "ask",
  browser_select_option: "ask",
  browser_press_key: "ask",
  browser_hover: "ask",
  browser_drag: "ask",
  browser_drop: "ask",
  browser_file_upload: "ask",
  browser_handle_dialog: "ask",
  browser_evaluate: "ask",
  browser_emulate_media: "ask",
  browser_resize: "ask",
  browser_close: "ask",
  // runs arbitrary code in the MCP server's Node process on the user's machine — outside every gate
  browser_run_code_unsafe: "deny",
};

export const ConfigSchema = z.object({
  clientId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/),
  frps: z
    .object({
      addr: z.string().default(""),
      port: z.number().int().min(1).max(65535).default(7000),
      user: z.string().default(""),
    })
    .default({}),
  folders: z.array(z.string()).default([]),
  approvalTimeoutSec: z.number().int().min(5).max(600).default(55),
  control: z.object({ port: z.number().int().min(1024).max(65535).default(47810) }).default({}),
  terminal: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(1024).max(65535).default(47811),
      shell: z.string().default(""), // "" = platform default (powershell.exe on Windows, bash elsewhere)
      autoAllow: z.boolean().default(true), // allowlisted read-only commands run without asking
    })
    .default({}),
  browser: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(1024).max(65535).default(47812),
      executablePath: z.string().default(""), // "" = Chrome; set for Brave/Edge
      profileDirName: z.string().default(""),
      tools: z.record(ToolMode).default({}),
    })
    .default({}),
  // Bridge-native programs behind one gate. No apps.enabled: the gate is up when any program is on.
  apps: z
    .object({
      port: z.number().int().min(1024).max(65535).default(47813),
      office: z
        .object({
          enabled: z.boolean().default(false),
          trustScripts: z.boolean().default(false), // agent scripts outside the pool run without a card
        })
        .default({}),
    })
    .default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

// The apps gate is needed when at least one program is switched on (only office for now).
export function appsEnabled(cfg: Config): boolean {
  return cfg.apps.office.enabled;
}

export function dataDir(): string {
  if (process.env.SB_DATA_DIR) return process.env.SB_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "agent-bridge");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "agent-bridge");
}

export function configPath(dir = dataDir()): string {
  return path.join(dir, "config.json");
}

export function loadConfig(dir = dataDir()): Config {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath(dir);
  let raw: unknown = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!obj.clientId) obj.clientId = "client-" + crypto.randomBytes(3).toString("hex");
  const cfg = ConfigSchema.parse(obj);
  if (!fs.existsSync(file)) saveConfig(cfg, dir);
  return cfg;
}

export function saveConfig(cfg: Config, dir = dataDir()): void {
  const parsed = ConfigSchema.parse(cfg);
  const file = configPath(dir);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function browserToolMode(cfg: Config, tool: string): ToolMode {
  return cfg.browser.tools[tool] ?? DEFAULT_BROWSER_TOOLS[tool] ?? "ask";
}

export function defaultShell(cfg: Config): string {
  if (cfg.terminal.shell) return cfg.terminal.shell;
  return process.platform === "win32" ? "powershell.exe" : "bash";
}
