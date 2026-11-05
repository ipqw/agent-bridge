#!/usr/bin/env node
// Stage everything the installer ships next to the Tauri binary, under app/src-tauri/resources/:
//   node/node(.exe)   — the Node runtime running the core (this very node binary)
//   core/             — built core (dist + UI) with production node_modules for THIS platform
//   core/runtime/     — Python side of the office gate (office_ops.py, guard.py, hashed lock), run by the
//                       CPython the bridge installs on enable (docs/ARCHITECTURE.md, «Офисные файлы»)
//   bin/frpc(.exe)    — pinned frp client, sha256-verified
// Run on the target OS (CI: windows-latest) after `npm run build` in core/.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "app", "src-tauri", "resources");
const win = process.platform === "win32";

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "node"), { recursive: true });
fs.mkdirSync(path.join(out, "bin"), { recursive: true });

// 1. Node runtime
fs.copyFileSync(process.execPath, path.join(out, "node", win ? "node.exe" : "node"));

// 2. Core: built output + production dependencies
const coreSrc = path.join(root, "core");
const coreOut = path.join(out, "core");
if (!fs.existsSync(path.join(coreSrc, "dist", "main.js")) || !fs.existsSync(path.join(coreSrc, "dist", "ui", "index.html")))
  throw new Error("core is not built: run `npm run build` in core/");
fs.mkdirSync(coreOut, { recursive: true });
fs.cpSync(path.join(coreSrc, "dist"), path.join(coreOut, "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(coreSrc, f), path.join(coreOut, f));
fs.cpSync(path.join(coreSrc, "runtime"), path.join(coreOut, "runtime"), {
  recursive: true,
  filter: (src) => path.basename(src) !== "__pycache__",
});
if (!fs.existsSync(path.join(coreOut, "runtime", "office-requirements.txt"))) throw new Error("core/runtime is missing the office lock");
execFileSync(win ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: coreOut, stdio: "inherit", shell: win });
// debug symbols of native prebuilds are large and useless at runtime
for (const dirent of fs.readdirSync(path.join(coreOut, "node_modules"), { recursive: true, withFileTypes: true })) {
  if (dirent.isFile() && dirent.name.endsWith(".pdb")) fs.rmSync(path.join(dirent.parentPath ?? dirent.path, dirent.name));
}

// 3. frpc
const frpTmp = path.join(root, "core", ".cache", "frp-dist");
execFileSync(process.execPath, [path.join(root, "scripts", "fetch-frp.mjs"), frpTmp], { stdio: "inherit" });
const frpc = win ? "frpc.exe" : "frpc";
fs.copyFileSync(path.join(frpTmp, frpc), path.join(out, "bin", frpc));

let size = 0;
for (const d of fs.readdirSync(out, { recursive: true, withFileTypes: true })) if (d.isFile()) size += fs.statSync(path.join(d.parentPath ?? d.path, d.name)).size;
console.log(`resources staged in ${out}: ${(size / 1e6).toFixed(1)} MB`);
