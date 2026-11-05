// Windows only: the autostart task (IgnoreNew + retry every minute) brings back a killed process.
// Uses the same task XML as the product, with a time trigger instead of the logon trigger.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskXml, currentUser, run } from "../src/autostart.ts";

const win = process.platform === "win32";
const TASK = "AgentBridgeSelfHealTest";

async function procIds(marker: string): Promise<number[]> {
  const { stdout } = await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'ping.exe' } | ForEach-Object { $_.ProcessId }`,
  ]);
  return stdout.split(/\s+/).filter(Boolean).map(Number);
}

test("killed process is restarted by the task retry", { skip: win ? false : "Windows only", timeout: 200_000 }, async () => {
  const marker = "127.0.0.42";
  // a long-running stand-in for the app: ping for ~1 hour
  const start = new Date(Date.now() + 5_000);
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  const xml = taskXml("C:\\Windows\\System32\\ping.exe", currentUser(), `-n 3600 ${marker}`, local);
  const file = path.join(os.tmpdir(), "sb-selfheal.xml");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  await run("schtasks.exe", ["/Create", "/TN", TASK, "/XML", file, "/F"]);
  try {
    await run("schtasks.exe", ["/Run", "/TN", TASK]);
    let first: number[] = [];
    for (let i = 0; i < 30 && !first.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      first = await procIds(marker);
    }
    assert.ok(first.length >= 1, "task started the process");
    // a second start while running is ignored (single instance)
    await run("schtasks.exe", ["/Run", "/TN", TASK]).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await procIds(marker)).length, 1, "IgnoreNew keeps one instance");

    await run("taskkill.exe", ["/F", "/PID", String(first[0])]);
    let back: number[] = [];
    for (let i = 0; i < 150 && !back.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      back = (await procIds(marker)).filter((p) => p !== first[0]);
    }
    assert.ok(back.length >= 1, "killed process came back within the retry interval");
  } finally {
    await run("schtasks.exe", ["/End", "/TN", TASK]).catch(() => {});
    await run("schtasks.exe", ["/Delete", "/TN", TASK, "/F"]).catch(() => {});
    for (const p of await procIds(marker).catch(() => [])) await run("taskkill.exe", ["/F", "/PID", String(p)]).catch(() => {});
  }
});
