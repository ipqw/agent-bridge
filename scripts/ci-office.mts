// CI helpers for the office part (T8). Run from core/: node --import tsx ../scripts/ci-office.mts <command>
//   timing       install the office runtime the way «Включить» does, then time office_read (cold, warm);
//                results go to the job summary. The runtime lands in core/.cache/test-office-runtime,
//                which the test suite reuses.
//   libreoffice  what «Скачать» in the window does after the client's consent: pinned MSI, msiexec /a,
//                soffice found. SB_LIBREOFFICE_MSI (cached MSI) skips the download, the sha is still checked.
//                Exports SB_SOFFICE for the LibreOffice tests.
//   msi-info     prints "<sha256> <url>" of the pinned MSI (cache key, cache fill).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OfficeRuntime, LIBREOFFICE } from "../core/src/office/runtime.ts";

const dataDir = path.resolve(".cache/test-office-runtime");
const runtimeSrc = path.resolve("runtime");
const log = (m: string) => console.log(m);

function summary(lines: string[]) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

async function timing() {
  const rt = new OfficeRuntime({ dataDir, runtimeSrc, log });
  let t = Date.now();
  await rt.ensure();
  const install = (Date.now() - t) / 1000;
  if (rt.status().state !== "ready") throw new Error(`runtime: ${rt.status().message}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sb-ci-office-"));
  const docx = path.join(work, "Отчёт.docx");
  execFileSync(rt.python(), ["-I", path.resolve("test/office-fixtures.py"), "docx", docx]);
  const read = async () => {
    const args = path.join(work, "args.json");
    fs.writeFileSync(args, JSON.stringify({ path: docx, out: path.join(work, "out.md") }));
    const t0 = Date.now();
    const r = await rt.runPy("office_ops.py", ["read", args], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`office_ops read: ${r.stderr}`);
    return (Date.now() - t0) / 1000;
  };
  t = Date.now();
  const cold = await read();
  const warm = await read();
  rt.close();
  fs.rmSync(work, { recursive: true, force: true });
  summary([
    `### Офисное окружение (${process.platform})`,
    "",
    "| Шаг | Время |",
    "|---|---|",
    `| установка окружения (uv → CPython → venv → пакеты) | ${install.toFixed(1)} с |`,
    `| первый office_read (холодный старт) | ${cold.toFixed(2)} с |`,
    `| второй office_read | ${warm.toFixed(2)} с |`,
  ]);
}

async function libreoffice() {
  const rt = new OfficeRuntime({ dataDir, runtimeSrc, log });
  const t = Date.now();
  await rt.installLibreOffice();
  const lo = rt.libreOffice();
  if (!lo.installed || !lo.soffice) throw new Error("soffice not found after install");
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `SB_SOFFICE=${lo.soffice}\n`);
  summary([`LibreOffice ${LIBREOFFICE.version}: ${lo.soffice} (${((Date.now() - t) / 1000).toFixed(0)} с, ${process.env.SB_LIBREOFFICE_MSI ? "MSI из кэша" : "скачан кодом моста"})`]);
}

const cmd = process.argv[2];
if (cmd === "timing") await timing();
else if (cmd === "libreoffice") await libreoffice();
else if (cmd === "msi-info") console.log(`${LIBREOFFICE.sha256} ${LIBREOFFICE.urls[0]}`);
else throw new Error(`unknown command: ${cmd}`);
