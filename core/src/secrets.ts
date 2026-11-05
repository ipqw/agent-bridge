// Secrets live in the OS secret store (Windows Credential Manager / macOS Keychain / Secret Service).
// Without a usable store (headless Linux dev box, CI) they fall back to a 0600 file in the data dir.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SECRET_NAMES = ["frpsToken", "sk", "gateToken", "extensionToken"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const SERVICE = "agent-bridge";

interface Store {
  get(name: SecretName): string | null;
  set(name: SecretName, value: string | null): void;
  kind: string;
}

class FileStore implements Store {
  kind = "file";
  constructor(private file: string) {}
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  get(name: SecretName) {
    return this.read()[name] ?? null;
  }
  set(name: SecretName, value: string | null) {
    const all = this.read();
    if (value === null) delete all[name];
    else all[name] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}

class KeyringStore implements Store {
  kind = "os";
  constructor(private Entry: new (service: string, account: string) => KeyringEntry) {}
  get(name: SecretName) {
    return new this.Entry(SERVICE, name).getPassword() ?? null;
  }
  set(name: SecretName, value: string | null) {
    const e = new this.Entry(SERVICE, name);
    if (value === null) e.deletePassword();
    else e.setPassword(value);
  }
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(v: string): void;
  deletePassword(): boolean | void;
}

export async function openSecrets(dir: string): Promise<Store> {
  if (process.env.SB_SECRETS !== "file") {
    try {
      const mod = (await import("@napi-rs/keyring")) as unknown as { Entry: new (s: string, a: string) => KeyringEntry };
      const store = new KeyringStore(mod.Entry);
      // probe: a store that cannot round-trip is not usable
      store.set("gateToken", store.get("gateToken") ?? randomSecret());
      if (store.get("gateToken")) return store;
    } catch {
      /* fall through to file */
    }
  }
  return new FileStore(path.join(dir, "secrets.json"));
}

export function randomSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

// Secrets the bridge generates itself on first run; frpsToken / extensionToken are entered by the user.
export function ensureGenerated(store: Store): void {
  for (const n of ["sk", "gateToken"] as const) if (!store.get(n)) store.set(n, randomSecret());
}

export type Secrets = Store;
