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

# Host-key pinning: set OLX_KNOWN_HOSTS_FILE (user env, see OPERATIONS.md) to a
# file produced with `ssh-keyscan -H <instance-ip>` to upgrade from
# trust-on-first-use to strict checking — a hijacked DNS/route then fails the
# sync loudly instead of streaming the dump to an impostor host.
$knownHostArgs = @('-o', 'StrictHostKeyChecking=accept-new')
if ($env:OLX_KNOWN_HOSTS_FILE) {
  if (-not (Test-Path -LiteralPath $env:OLX_KNOWN_HOSTS_FILE)) {
    throw "OLX_KNOWN_HOSTS_FILE points to a missing file: $($env:OLX_KNOWN_HOSTS_FILE)"
  }
  $knownHostArgs = @('-o', "UserKnownHostsFile=$($env:OLX_KNOWN_HOSTS_FILE)",
                     '-o', 'StrictHostKeyChecking=yes')
}
$sshArgs = @('-i', $KeyPath, '-o', 'BatchMode=yes') + $knownHostArgs +
           @('-o', 'ServerAliveInterval=30')

# Do not pipe Get-Content -AsByteStream into ssh. PowerShell emits each byte as
# a separate pipeline object, which makes even a small dump take minutes to
# upload. Connect the file stream directly to ssh's standard input instead.
function Invoke-SshRestore([string]$dumpPath) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = 'ssh'
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($arg in $sshArgs) { [void]$startInfo.ArgumentList.Add($arg) }
  [void]$startInfo.ArgumentList.Add("$SshUser@$InstanceHost")
  [void]$startInfo.ArgumentList.Add('./db/remote-restore.sh')

  $ssh = [System.Diagnostics.Process]::new()
  $ssh.StartInfo = $startInfo
  $input = $null
  try {
    if (-not $ssh.Start()) { throw 'could not start ssh' }
    # Drain both output streams concurrently so neither can fill its OS pipe
    # and block the restore while the dump is being uploaded.
    $stdoutTask = $ssh.StandardOutput.ReadToEndAsync()
    $stderrTask = $ssh.StandardError.ReadToEndAsync()
    $input = [System.IO.File]::OpenRead($dumpPath)
    $input.CopyTo($ssh.StandardInput.BaseStream, 1MB)
    $ssh.StandardInput.Close()
    Log 'upload complete; waiting for remote validation and restore...'
    $ssh.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $output = @($stdout, $stderr) -join "`n"
    if ($ssh.ExitCode -ne 0) {
      throw "remote restore failed (ssh exit $($ssh.ExitCode)): $($output.Trim())"
    }
    return $output -split "`r?`n" | Where-Object { $_ }
  } finally {
    if ($input) { $input.Dispose() }
    $ssh.Dispose()
  }
}

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

# Compose can retain stopped dependency containers after Docker Desktop
# recreates a project network. Such a container still has the old network mode
# in its config, but no endpoint in NetworkSettings.Networks; `compose run`
# then fails while starting the dependency with "not connected to the network".
# Remove only those broken Compose-managed containers. This never touches a
# volume, and healthy/running containers are left alone.
function Remove-StaleComposeContainer([string]$service) {
  $id = (& docker compose --profile scrape ps -aq $service 2>$null |
    Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) { return }
  $id = $id.Trim()

  $status = (& docker inspect --format '{{.State.Status}}' $id 2>$null |
    Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $status.Trim() -notin @('created', 'exited', 'dead')) {
    return
  }

  $networks = (& docker inspect --format '{{json .NetworkSettings.Networks}}' $id 2>$null |
    Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($networks)) { return }
  try { $networkInfo = $networks.Trim() | ConvertFrom-Json -ErrorAction Stop }
  catch { return }
  $attached = @($networkInfo.PSObject.Properties.Value |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_.NetworkID) })
  if ($attached.Count -gt 0) { return }

  Log "removing stale Compose container $service ($id) with no network endpoint..."
  docker rm -f $id *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "could not remove stale Compose container $service ($id)"
  }
}

Remove-StaleComposeContainer 'db'
Remove-StaleComposeContainer 'migrator'

Log 'building scraper image from current source...'
docker compose --profile scrape build scraper
if ($LASTEXITCODE -ne 0) { throw "scraper image build failed (exit $LASTEXITCODE)" }

Log 'scraping (full cycle, all searches)...'
docker compose --profile scrape run --rm scraper node src/index.js --once
if ($LASTEXITCODE -ne 0) { throw "scrape failed (exit $LASTEXITCODE) - instance left untouched; retry later" }

Log 'dumping database...'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpName = "olx-sync-$stamp.dump"
# Read the Compose-configured bootstrap role and database inside the container;
# this keeps sync aligned with POSTGRES_USER/POSTGRES_DB overrides in .env.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -f "$1" "$POSTGRES_DB"' sh "/backups/$dumpName"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
$dump = Join-Path $root "backups/$dumpName"
if ((Get-Item $dump).Length -lt 20000) { throw "dump suspiciously small - aborting" }

Log ('streaming {0:N0} bytes to {1}@{2} and restoring...' -f (Get-Item $dump).Length, $SshUser, $InstanceHost)
$out = Invoke-SshRestore $dump
$out | ForEach-Object { Log "remote: $_" }

if (($out -join "`n") -match 'RESTORE_OK') {
  Log 'sync complete - instance database updated.'
  # Prune local dumps now that the instance confirmed the restore — every
  # scheduled run otherwise drops another olx-sync-*.dump into ./backups
  # forever. Keep the newest few (timestamped names sort chronologically).
  # Dumps from FAILED runs never reach this branch, so they stay for forensics.
  Get-ChildItem (Join-Path $root 'backups') -Filter 'olx-sync-*.dump' |
    Sort-Object Name -Descending | Select-Object -Skip 3 | ForEach-Object {
      Log "pruning superseded local dump: $($_.Name)"
      Remove-Item -LiteralPath $_.FullName -Force
    }
} else {
  throw 'remote restore did not report RESTORE_OK - check the instance'
}
