# Starts the isolated dev stack for manual testing: server on 3101, Vite on 5273.
# It uses its OWN database and keys under %TEMP%\remotecli-live-test, so it never touches ~\.remotecli (the installed app).
# Sign in with an account created earlier in that database (it is kept between runs).
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-test-stack.ps1
# Stop: Ctrl+C in this window (concurrently --kill-others ends both).

$ServerPort = 3101
$VitePort = 5273
$root = Join-Path $env:TEMP 'remotecli-live-test'
$appDir = Split-Path -Parent $PSScriptRoot

# Free the two ports first (a stale stack from an earlier run would make the new one fail with EADDRINUSE).
foreach ($port in $ServerPort, $VitePort) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { taskkill /PID $_.OwningProcess /T /F | Out-Null; Write-Host "freed port $port (pid $($_.OwningProcess))" }
}

New-Item -ItemType Directory -Force $root | Out-Null
Set-Location $appDir

# Claude Code's own variables make a child server think it runs inside a Claude session: drop them.
foreach ($k in 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET',
               'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT') {
  Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}

$env:SERVER_PORT = "$ServerPort"
$env:VITE_PORT = "$VitePort"
$env:DATABASE_PATH = Join-Path $root 'auth.db'
$env:AGENT_PROFILES_DIR = Join-Path $root 'agent-profiles'
$env:REMOTECLI_REMOTE_MASTER_KEY_FILE = Join-Path $root 'remote-master.key'
$env:CLOUDCLI_REMOTE_MASTER_KEY_FILE = Join-Path $root 'remote-master.key'

Write-Host "Open http://localhost:$VitePort  (API on $ServerPort, data in $root)"
npm run dev
