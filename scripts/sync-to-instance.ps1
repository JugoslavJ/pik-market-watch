#requires -Version 7
<#
  OLX market watch - home-machine scrape + sync to the OCI instance.

  Pipeline: full scrape (Docker) -> pg_dump -> stream to instance over SSH ->
  remote forced-command endpoint verifies and restores (scraper paused during
  restore). The instance is left untouched unless the whole pipeline succeeds.

  Config (user environment variables, set once):
    OLX_INSTANCE_HOST  e.g. 203.0.113.10
    OLX_SSH_USER       e.g. opc
    OLX_SYNC_KEY       e.g. C:\Users\you\.ssh\olx_sync_key
#>
param()
$ErrorActionPreference = 'Stop'
function Log([string]$m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

foreach ($v in 'InstanceHost', 'SshUser', 'KeyPath') {
  if (-not (Get-Variable $v -ValueOnly)) { throw "missing config: set the $v environment variable (OLX_$(($v -replace '([A-Z])', '_$1')).ToUpper())" }
}
if (-not (Test-Path $KeyPath)) { throw "sync key not found: $KeyPath" }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Log 'scraping (full cycle, all searches)...'
docker compose run --rm scraper node src/index.js --once
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