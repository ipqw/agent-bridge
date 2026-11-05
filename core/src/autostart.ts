// Autostart on Windows: a Task Scheduler task that starts the bridge at logon, in the user's
// interactive session, and re-tries every minute (IgnoreNew keeps a single instance) — so a
// crashed or killed bridge comes back by itself. Fallback when the task cannot be created:
// the HKCU Run key (starts at the next logon only, no self-healing).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const TASK_NAME = "AgentBridge";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export interface AutostartStatus {
  supported: boolean;
  mode: "task" | "runkey" | "none";
  detail: string;
}

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// `timeStart` replaces the logon trigger with a time trigger (same repetition) — used by the
// Windows CI test to prove that a killed process is brought back by the retry.
export function taskXml(exe: string, user: string, args = "--autostart", timeStart?: string): string {
  const u = xmlEscape(user);
  const repetition = "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>";
  const trigger = timeStart
    ? `<TimeTrigger><Enabled>true</Enabled><StartBoundary>${timeStart}</StartBoundary>${repetition}</TimeTrigger>`
    : `<LogonTrigger><Enabled>true</Enabled><UserId>${u}</UserId><Delay>PT5S</Delay>${repetition}</LogonTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Agent Bridge: local hands for the remote agent</Description></RegistrationInfo>
  <Triggers>
    ${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${u}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xmlEscape(exe)}</Command><Arguments>${xmlEscape(args)}</Arguments></Exec>
  </Actions>
</Task>
`;
}

export function currentUser() {
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME ?? os.userInfo().username);
}

export async function enableAutostart(exe: string, tmpDir: string): Promise<AutostartStatus> {
  if (process.platform !== "win32") return { supported: false, mode: "none", detail: "только Windows" };
  const file = path.join(tmpDir, "agent-bridge-task.xml");
  // schtasks expects UTF-16LE with BOM
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(exe, currentUser()), "utf16le")]));
  try {
    await run("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", file, "/F"], { windowsHide: true });
    await run("reg.exe", ["delete", RUN_KEY, "/v", TASK_NAME, "/f"], { windowsHide: true }).catch(() => {});
    return { supported: true, mode: "task", detail: "Планировщик: при входе + повтор каждую минуту" };
  } catch (e) {
    await run("reg.exe", ["add", RUN_KEY, "/v", TASK_NAME, "/d", `"${exe}" --autostart`, "/f"], { windowsHide: true });
    return { supported: true, mode: "runkey", detail: `Run-ключ (планировщик отказал: ${String(e).slice(0, 200)})` };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function disableAutostart(): Promise<AutostartStatus> {
  if (process.platform !== "win32") return { supported: false, mode: "none", detail: "только Windows" };
  await run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], { windowsHide: true }).catch(() => {});
  await run("reg.exe", ["delete", RUN_KEY, "/v", TASK_NAME, "/f"], { windowsHide: true }).catch(() => {});
  return { supported: true, mode: "none", detail: "выключен" };
}

export async function autostartStatus(): Promise<AutostartStatus> {
  if (process.platform !== "win32") return { supported: false, mode: "none", detail: "только Windows" };
  try {
    await run("schtasks.exe", ["/Query", "/TN", TASK_NAME], { windowsHide: true });
    return { supported: true, mode: "task", detail: "Планировщик: при входе + повтор каждую минуту" };
  } catch {
    /* no task */
  }
  try {
    await run("reg.exe", ["query", RUN_KEY, "/v", TASK_NAME], { windowsHide: true });
    return { supported: true, mode: "runkey", detail: "Run-ключ (без самолечения)" };
  } catch {
    return { supported: true, mode: "none", detail: "выключен" };
  }
}
