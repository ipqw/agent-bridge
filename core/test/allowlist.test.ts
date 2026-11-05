import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommandLine, taintsSession, type AllowContext } from "../src/allowlist.ts";
import { parseScreen } from "../src/screen.ts";

const ps: AllowContext = { shell: "powershell", cwd: "C:\\Users\\ilya\\Docs", folders: ["C:\\Users\\ilya\\Docs"], windows: true };
const ok = (line: string, ctx = ps) => assert.equal(checkCommandLine(line, ctx).ok, true, line);
const no = (line: string, ctx = ps) => {
  const r = checkCommandLine(line, ctx);
  assert.equal(r.ok, false, `${line} should be refused`);
};

test("powershell: read-only commands inside the allowed folder pass", () => {
  ok("Get-Content C:\\Users\\ilya\\Docs\\a.txt");
  ok("gc a.txt");
  ok("cat 'C:\\Users\\ilya\\Docs\\with space.txt'");
  ok("Get-ChildItem");
  ok("ls -Recurse");
  ok("dir C:\\Users\\ilya\\Docs\\sub -Filter *.docx");
  ok("Get-Content -Path .\\a.txt -Tail 50");
  ok("Select-String -Pattern 'invoice' -Path C:\\Users\\ilya\\Docs\\*.txt");
  ok("sls invoice a.txt");
  ok("cd sub");
  ok("pwd");
  ok("Get-FileHash a.docx -Algorithm SHA256");
  ok("GET-CONTENT A.TXT");
  ok("c:\\users\\ILYA\\docs\\x.txt".length ? "gc c:\\users\\ILYA\\docs\\x.txt" : "");
});

test("powershell: outside the folders, or not a plain read, is refused", () => {
  no("Get-Content C:\\Users\\ilya\\.ssh\\id_rsa");
  no("gc ..\\secret.txt");
  no("gc C:\\Users\\ilya\\Docs\\..\\secret.txt");
  no("cd ..");
  no("cd");
  no("gc a.txt; rm a.txt");
  no("gc a.txt | Out-File b.txt");
  no("gc a.txt > b.txt");
  no("gc $env:USERPROFILE\\x");
  no("gc \"$(whoami)\"");
  no("gc `a.txt");
  no("gc (Get-Item a.txt)");
  no("Remove-Item a.txt");
  no("rm a.txt");
  no("iex 'gc a.txt'");
  no("& gc a.txt");
  no(". .\\script.ps1");
  no("gc \\\\server\\share\\x");
  no("gc Env:PATH");
  no("gc HKLM:\\SOFTWARE");
  no("gc a.txt:stream");
  no("gc C:a.txt");
  no("gc \\Windows\\win.ini");
  no("gc ~\\x");
  no("gc a.txt,b.txt");
  no("gc -Pa a.txt"); // abbreviated parameter
  no("gc -Path:a.txt");
  no("ls -Path C:\\Users\\ilya\\*\\x");
  no("Start-Process notepad");
  no("gc a\u202Etxt.exe");
  no("gc --% a.txt");
  no("Set-Content a.txt x");
});

test("powershell: unknown cwd forbids relative paths", () => {
  no("gc a.txt", { ...ps, cwd: null });
  ok("gc C:\\Users\\ilya\\Docs\\a.txt", { ...ps, cwd: null });
  no("ls", { ...ps, cwd: "C:\\Windows" });
});

const px: AllowContext = { shell: "posix", cwd: "/home/u/docs", folders: ["/home/u/docs"], windows: false };

test("posix: basic allow/deny", () => {
  ok("cat /home/u/docs/a.txt", px);
  ok("ls -la", px);
  ok("head -n 20 a.txt", px);
  ok("grep -rn invoice /home/u/docs", px);
  no("cat /etc/passwd", px);
  no("cat a.txt && rm a.txt", px);
  no("cat ~/x", px);
  no("rm a.txt", px);
  no("cat $(echo a)", px);
  no("cd /", px);
});

test("taint detection", () => {
  assert.equal(taintsSession("function gc { rm $args }"), true);
  assert.equal(taintsSession("Set-Alias cat Remove-Item"), true);
  assert.equal(taintsSession(". .\\evil.ps1"), true);
  assert.equal(taintsSession("Remove-Item a.txt"), false);
});

test("screen: powershell prompt, cwd and wrapped line", () => {
  const cols = 20;
  const content = ["PS C:\\Users\\ilya> ", "PS C:\\Users\\ilya> gc", "x"].join("\n");
  const r = parseScreen({ content, cursor: { x: 1, y: 2 }, dimensions: { cols, rows: 3 } }, "powershell");
  // row 1 is 20 chars => wraps into row 2
  assert.equal(r.promptRecognized, true);
  assert.equal(r.cwd, "C:\\Users\\ilya");
  assert.equal(r.command, "gcx");
});

test("screen: continuation rows are multi-line; no prompt => not recognized", () => {
  const multi = parseScreen({ content: "PS C:\\a> if ($true) {\n>> rm x\n>> }", cursor: { x: 4, y: 2 }, dimensions: { cols: 80, rows: 3 } }, "powershell");
  assert.equal(multi.multiline, true);
  assert.equal(multi.promptRecognized, true);
  const prog = parseScreen({ content: "Overwrite file? [y/N] y", cursor: { x: 23, y: 0 }, dimensions: { cols: 80, rows: 1 } }, "powershell");
  assert.equal(prog.promptRecognized, false);
});
