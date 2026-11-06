# Courtside auto-update (Windows): brings this folder up to date with GitHub's main branch.
#
# Chrome doesn't update "Load unpacked" extensions by itself. Run by the scheduled task from
# install-auto-update.ps1, this keeps the folder Chrome loads Courtside from current, and Courtside's background
# script then notices the newer version and reloads itself.
#
# Safe by design: it only fast-forwards. With local changes, or a history that has diverged from GitHub, it does
# nothing and says so in the log (%LOCALAPPDATA%\Courtside\auto-update.log).
param([string]$Repo = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:LOCALAPPDATA "Courtside"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "auto-update.log"
function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  # Keep the log short.
  $all = Get-Content $log -ErrorAction SilentlyContinue
  if ($all.Count -gt 300) { $all | Select-Object -Last 200 | Set-Content $log -Encoding UTF8 }
}

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
if (-not (Test-Path $git)) { Log "skipped: git not found"; exit 0 }
if (-not (Test-Path (Join-Path $Repo ".git"))) { Log "skipped: $Repo is not a git folder"; exit 0 }

try {
  Set-Location $Repo
  $dirty = & $git status --porcelain --untracked-files=no
  if ($dirty) { Log "skipped: local changes in $Repo"; exit 0 }
  & $git fetch --quiet origin main 2>$null
  if ($LASTEXITCODE -ne 0) { Log "skipped: couldn't reach GitHub"; exit 0 }
  $behind = [int](& $git rev-list --count HEAD..origin/main)
  if ($behind -eq 0) { exit 0 } # already current: nothing to log
  $before = (& $git log -1 --format=%h)
  & $git merge --ff-only --quiet origin/main 2>$null
  if ($LASTEXITCODE -ne 0) { Log "skipped: this folder's history differs from GitHub's (no fast-forward)"; exit 0 }
  $ver = (Get-Content (Join-Path $Repo "manifest.json") -Raw | ConvertFrom-Json).version
  Log ("updated {0} -> {1} (Courtside {2}, {3} new commit{4})" -f $before, (& $git log -1 --format=%h), $ver, $behind, $(if ($behind -eq 1) { "" } else { "s" }))
} catch {
  Log ("error: " + $_.Exception.Message)
}
