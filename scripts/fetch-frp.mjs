#!/usr/bin/env node
// Download a pinned frp release, verify sha256 against the release checksum file, extract frpc/frps.
// Usage: node scripts/fetch-frp.mjs <outDir> [platform] [arch]   (defaults: this machine)
//   platform: linux | windows | darwin   arch: amd64 | arm64

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const VERSION = "0.71.0";
const outDir = path.resolve(process.argv[2] ?? ".cache/frp");
const platform = process.argv[3] ?? ({ win32: "windows", darwin: "darwin" }[process.platform] ?? "linux");
const arch = process.argv[4] ?? (process.arch === "arm64" ? "arm64" : "amd64");
const ext = platform === "windows" ? "zip" : "tar.gz";
const name = `frp_${VERSION}_${platform}_${arch}`;
const base = `https://github.com/fatedier/frp/releases/download/v${VERSION}`;
const exe = platform === "windows" ? ".exe" : "";

if (fs.existsSync(path.join(outDir, `frpc${exe}`)) && fs.existsSync(path.join(outDir, `frps${exe}`))) {
  console.log(`frp ${VERSION} already in ${outDir}`);
  process.exit(0);
}

async function get(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const sums = (await get(`${base}/frp_sha256_checksums.txt`)).toString();
const want = sums.split("\n").find((l) => l.trim().endsWith(`${name}.${ext}`))?.split(/\s+/)[0];
if (!want) throw new Error(`no checksum for ${name}.${ext}`);
const archive = await get(`${base}/${name}.${ext}`);
const got = crypto.createHash("sha256").update(archive).digest("hex");
if (got !== want) throw new Error(`sha256 mismatch for ${name}.${ext}: ${got} != ${want}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "frp-"));
const file = path.join(work, `${name}.${ext}`);
fs.writeFileSync(file, archive);
execFileSync("tar", ["-xf", file, "-C", work], { stdio: "inherit" });
fs.mkdirSync(outDir, { recursive: true });
for (const bin of ["frpc", "frps"]) {
  fs.copyFileSync(path.join(work, name, bin + exe), path.join(outDir, bin + exe));
  fs.chmodSync(path.join(outDir, bin + exe), 0o755);
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`frp ${VERSION} ${platform}/${arch} -> ${outDir} (sha256 ok)`);
