#requires -Version 7
<#
  OLX market watch - home-machine scrape + sync to the OCI instance.

  Pipeline: full scrape (Docker) -> pg_dump -> stream to instance over SSH ->
  remote forced-command endpoint verifies and restores (scraper paused during
  restore). The instance is left untouched unless the whole pipeline succeeds.

  Config (user environment variables, set once — start a fresh terminal
  afterwards so they are visible to new sessions and scheduled tasks):
    OLX_INSTANCE_HOST  e.g. 203.0.113.10
    OLX_SSH_USER       e.g. opc
    OLX_SYNC_KEY       e.g. C:\Users\you\.ssh\olx_sync_key
#>
param()
$ErrorActionPreference = 'Stop'
$syncLog = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\sync.log'
function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Output $line
  try {   # scheduled runs have no console - keep an on-disk trail too
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $syncLog) | Out-Null
    Add-Content -LiteralPath $syncLog -Value $line -ErrorAction Stop
  } catch { }
}

foreach ($e in 'OLX_INSTANCE_HOST', 'OLX_SSH_USER', 'OLX_SYNC_KEY') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($e))) {
    throw "missing config: set the $e user environment variable, e.g. [Environment]::SetEnvironmentVariable('$e', '<value>', 'User')"
  }
}
$InstanceHost = $env:OLX_INSTANCE_HOST
$SshUser      = $env:OLX_SSH_USER
$KeyPath      = $env:OLX_SYNC_KEY
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "sync key not found: $KeyPath" }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# A scheduled run wakes the PC straight into this script; Docker Desktop only
# autostarts with a user session, so bring the engine up ourselves if needed.
function Test-DockerEngine { docker info --format ok *> $null; return ($LASTEXITCODE -eq 0) }
if (-not (Test-DockerEngine)) {
  Log 'docker engine not reachable - starting Docker Desktop...'
  $dd = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
          "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $dd) { throw 'docker engine is down and Docker Desktop.exe was not found - start it manually once' }
  Start-Process $dd
  $deadline = (Get-Date).AddMinutes(4)
  while (-not (Test-DockerEngine)) {
    if ((Get-Date) -gt $deadline) { throw 'docker engine did not come up within 4 minutes' }
    Start-Sleep -Seconds 5
  }
  Log 'docker engine ready.'
}

Log 'building scraper image from current source...'
docker compose --profile scrape build scraper
if ($LASTEXITCODE -ne 0) { throw "scraper image build failed (exit $LASTEXITCODE)" }

Log 'scraping (full cycle, all searches)...'
docker compose --profile scrape run --rm scraper node src/index.js --once
if ($LASTEXITCODE -ne 0) { throw "scrape failed (exit $LASTEXITCODE) - instance left untouched; retry later" }

Log 'dumping database...'
docker compose exec -T db pg_dump -U olx -Fc -f /backups/olx-sync.dump olx
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
$dump = Join-Path $root 'backups/olx-sync.dump'
if ((Get-Item $dump).Length -lt 20000) { throw "dump suspiciously small - aborting" }

Log ('streaming {0:N0} bytes to {1}@{2} and restoring...' -f (Get-Item $dump).Length, $SshUser, $InstanceHost)
$out = Get-Content $dump -AsByteStream |
  ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 `
    "$SshUser@$InstanceHost" ./db/remote-restore.sh
$out | ForEach-Object { Log "remote: $_" }

if (($out -join "`n") -match 'RESTORE_OK') {
  Log 'sync complete - instance database updated.'
} else {
  throw 'remote restore did not report RESTORE_OK - check the instance'
}