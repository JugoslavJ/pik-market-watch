#requires -Version 7
# Scrape locally, dump the database and stream it to the forced-command restore endpoint.
# Required user environment: OLX_INSTANCE_HOST, OLX_SSH_USER, OLX_SYNC_KEY.
param()
$ErrorActionPreference = 'Stop'
$syncLog = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\sync.log'
function Write-SyncLog([string[]]$messages) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $lines = @($messages | ForEach-Object { "[$timestamp] $_" })
  Write-Output $lines
  try {   # scheduled runs have no console - keep an on-disk trail too
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $syncLog) | Out-Null
    Add-Content -LiteralPath $syncLog -Value $lines -ErrorAction Stop
  } catch { }
}
function Log([string]$m) { Write-SyncLog @($m) }

foreach ($e in 'OLX_INSTANCE_HOST', 'OLX_SSH_USER', 'OLX_SYNC_KEY') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($e))) {
    throw "missing config: set the $e user environment variable, e.g. [Environment]::SetEnvironmentVariable('$e', '<value>', 'User')"
  }
}
$InstanceHost = $env:OLX_INSTANCE_HOST
$SshUser      = $env:OLX_SSH_USER
$KeyPath      = $env:OLX_SYNC_KEY
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "sync key not found: $KeyPath" }

# OLX_KNOWN_HOSTS_FILE enables strict host-key checks; otherwise trust the first connection.
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

# Copy directly to stdin; a PowerShell byte pipeline uploads too slowly.
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
    # Drain both output pipes during upload to avoid deadlocking SSH.
    $stdoutTask = $ssh.StandardOutput.ReadToEndAsync()
    $stderrTask = $ssh.StandardError.ReadToEndAsync()
    $input = [System.IO.File]::OpenRead($dumpPath)
    $input.CopyTo($ssh.StandardInput.BaseStream, 1MB)
    $ssh.StandardInput.Close()
    # Status output must not become part of the captured restore protocol.
    Log 'upload complete; waiting for remote validation and restore...' | Out-Host
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

# Scheduled runs may start before Docker Desktop.
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

# Remove stopped Compose containers whose stale network configuration prevents startup.
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

Log 'building scraper and migrator images from current source...'
docker compose --profile scrape build scraper migrator
if ($LASTEXITCODE -ne 0) { throw "scraper/migrator image build failed (exit $LASTEXITCODE)" }

Log 'starting database and ensuring migration ownership...'
docker compose up -d --wait db
if ($LASTEXITCODE -ne 0) { throw "database failed to become healthy (exit $LASTEXITCODE)" }
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
if ($LASTEXITCODE -ne 0) { throw "database ownership repair failed (exit $LASTEXITCODE)" }

# Pause an existing scraper through the snapshot window; restore its state on failure.
$scraperWasRunning = $false
$runningScraper = (& docker compose --profile scrape ps --status running -q scraper 2>$null |
  Select-Object -First 1)
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($runningScraper)) {
  Log "pausing running scraper ($($runningScraper.Trim())) for sync..."
  docker compose --profile scrape stop scraper
  if ($LASTEXITCODE -ne 0) { throw "could not stop the running scraper (exit $LASTEXITCODE)" }
  $scraperWasRunning = $true
}

try {
  Log 'scraping and publishing local analytics snapshot (full cycle, all searches)...'
  docker compose --profile scrape run --rm scraper node src/index.js --once
  if ($LASTEXITCODE -ne 0) { throw "scrape failed (exit $LASTEXITCODE) - instance left untouched; retry later" }

  Log 'dumping database...'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dumpName = "olx-sync-$stamp.dump"
  docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -Z zstd:9 -f "$1" "$POSTGRES_DB"' sh "/backups/$dumpName"
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
  $dump = Join-Path $root "backups/$dumpName"
  if ((Get-Item $dump).Length -lt 20000) { throw "dump suspiciously small - aborting" }

  Log ('streaming {0:N0} bytes to {1}@{2} and restoring...' -f (Get-Item $dump).Length, $SshUser, $InstanceHost)
  $remoteTimer = [Diagnostics.Stopwatch]::StartNew()
  $out = Invoke-SshRestore $dump
  $remoteTimer.Stop()
  Log ('remote processing finished in {0:N1}s; saving output...' -f $remoteTimer.Elapsed.TotalSeconds)
  $logTimer = [Diagnostics.Stopwatch]::StartNew()
  Write-SyncLog @($out | ForEach-Object { "remote: $_" })
  $logTimer.Stop()
  Log ('remote output saved in {0:N1}s' -f $logTimer.Elapsed.TotalSeconds)

  if (($out -join "`n") -match 'RESTORE_OK') {
    Log 'sync complete - instance database updated.'
    # Prune successful dumps; failed runs keep their archives for diagnosis.
    Get-ChildItem (Join-Path $root 'backups') -Filter 'olx-sync-*.dump' |
      Sort-Object Name -Descending | Select-Object -Skip 3 | ForEach-Object {
        Log "pruning superseded local dump: $($_.Name)"
        Remove-Item -LiteralPath $_.FullName -Force
      }
  } else {
    throw 'remote restore did not report RESTORE_OK - check the instance'
  }
} finally {
  if ($scraperWasRunning) {
    Log 'resuming scraper service after sync...'
    docker compose --profile scrape start scraper
    if ($LASTEXITCODE -ne 0) {
      Log "WARNING: could not resume scraper service (exit $LASTEXITCODE)"
    }
  }
}
