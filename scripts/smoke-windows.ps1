# Smoke test of the built MSI on a clean Windows runner:
#   install -> start -> control UI + both gates listen (packaged node, terminal-mcp/node-pty, playwright-mcp load)
#   -> autostart task registered -> core killed => shell restarts it
#   -> app killed => whole process tree gone (job object), ports closed.
$ErrorActionPreference = "Stop"

function Wait-Port([int]$port, [bool]$open, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $listening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listening -eq $open) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Core-Procs { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "*Agent Bridge*" -and $_.Name -eq "node.exe" } }
function Fail([string]$m) { Write-Host "SMOKE FAIL: $m"; exit 1 }

$msi = Get-ChildItem app/src-tauri/target/release/bundle/msi/*.msi | Select-Object -First 1
if (-not $msi) { Fail "no msi" }
Write-Host "installing $($msi.Name) ($([math]::Round($msi.Length/1MB,1)) MB)"
$p = Start-Process msiexec.exe -ArgumentList "/i", "`"$($msi.FullName)`"", "/qn", "/l*v", "install.log" -Wait -PassThru
if ($p.ExitCode -ne 0) { Get-Content install.log -Tail 50; Fail "msiexec exit $($p.ExitCode)" }

$exe = Get-ChildItem "C:\Program Files\Agent Bridge\*.exe" | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1
if (-not $exe) { Fail "installed exe not found" }
Write-Host "starting $($exe.FullName)"
Start-Process $exe.FullName

foreach ($port in 47810, 47811, 47812) {
  if (-not (Wait-Port $port $true 90)) { Fail "port $port not listening" }
  Write-Host "port $port listening"
}

$ui = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47810/
if ($ui.StatusCode -ne 200 -or $ui.Content -notmatch "<title>") { Fail "control UI not served" }
Write-Host "control UI served"

# office (#1): the Python sources and the hashed lock ship with the installer (the env itself is downloaded on «Включить»)
$guard = Get-ChildItem "C:\Program Files\Agent Bridge" -Recurse -Filter guard.py -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $guard) { Fail "core/runtime (guard.py) not in the installed tree" }
foreach ($f in "office_ops.py", "office-requirements.txt") {
  if (-not (Test-Path (Join-Path $guard.DirectoryName $f))) { Fail "$f not next to guard.py" }
}
Write-Host "office runtime sources installed: $($guard.DirectoryName)"

try {
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:47811/mcp -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | Out-Null
  Fail "gate answered without a token"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 401) { Fail "gate: expected 401, got $($_.Exception.Message)" }
}
Write-Host "terminal gate refuses requests without the token (401)"

schtasks.exe /Query /TN AgentBridge | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "autostart task AgentBridge not registered" }
Write-Host "autostart task registered"

# core crash -> the shell restarts it
$core = Core-Procs | Select-Object -First 1
if (-not $core) { Fail "core process not found" }
Stop-Process -Id $core.ProcessId -Force
if (-not (Wait-Port 47811 $false 15)) { Write-Host "(gate port did not drop — restarted fast)" }
if (-not (Wait-Port 47811 $true 60)) { Fail "core was not restarted by the shell" }
Write-Host "core killed -> restarted by the shell"

# shell killed -> the whole tree dies (job object), ports close
Get-Process | Where-Object { $_.Path -eq $exe.FullName } | Stop-Process -Force
foreach ($port in 47810, 47811, 47812) {
  if (-not (Wait-Port $port $false 20)) { Fail "port $port still open after the app was killed" }
}
Start-Sleep -Seconds 2
if (Core-Procs) { Fail "core/node processes survived the app" }
$leftover = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "*Agent Bridge*" }
if ($leftover) { $leftover | Format-Table Name, ProcessId, ExecutablePath; Fail "processes survived the app" }
Write-Host "app killed -> process tree gone, ports closed"
Write-Host "SMOKE OK"
