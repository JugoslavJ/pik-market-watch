#requires -Version 7
param(
  [ValidateSet('success', 'build-failure', 'scrape-failure', 'dump-failure', 'restore-failure')]
  [string]$Scenario
)
$ErrorActionPreference = 'Stop'

# Execute the real sync workflow in a disposable checkout. Replace only the
# external Docker command and SSH transport; no engine or host is contacted.
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempRoot ('olx-sync-test-' + [Guid]::NewGuid().ToString('N'))
$originalLocation = Get-Location
$global:SyncVerificationCommands = [Collections.Generic.List[string]]::new()
$global:SyncVerificationScenario = $Scenario
$global:SyncVerificationRoot = $fixtureRoot

function global:docker {
  # A simple function preserves native CLI flags such as -d and -T; an
  # advanced function would bind them as PowerShell common parameters.
  [string[]]$DockerArguments = $args
  $global:LASTEXITCODE = 0
  $command = $DockerArguments -join ' '
  $global:SyncVerificationCommands.Add($command)
  if ($command -eq 'info --format ok') { return 'ok' }
  if ($command -like 'compose --profile scrape ps -aq *') { return }
  if ($command -eq 'compose --profile scrape ps --status running -q scraper') {
    return 'fixture-scraper'
  }
  if ($command -eq 'compose --profile scrape build scraper migrator' -and
      $global:SyncVerificationScenario -eq 'build-failure') {
    $global:LASTEXITCODE = 7
    return
  }
  if ($command -eq 'compose --profile scrape run --rm scraper node src/index.js --once' -and
      $global:SyncVerificationScenario -eq 'scrape-failure') {
    $global:LASTEXITCODE = 8
    return
  }
  if ($command.Contains('pg_dump')) {
    if ($global:SyncVerificationScenario -eq 'dump-failure') {
      $global:LASTEXITCODE = 9
      return
    }
    $dumpFile = Join-Path $global:SyncVerificationRoot ('backups/' + [IO.Path]::GetFileName($DockerArguments[-1]))
    [IO.File]::WriteAllBytes($dumpFile, [byte[]]::new(30000))
    return
  }
  if ($command -notin @(
      'compose up -d --wait db',
      'compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh',
      'compose --profile scrape build scraper migrator',
      'compose --profile scrape stop scraper',
      'compose --profile scrape run --rm scraper node src/index.js --once',
      'compose --profile scrape start scraper'
    )) { throw "Unexpected Docker command: $command" }
}

function Assert-Condition([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

try {
  New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'backups') -Force | Out-Null
  $sourceFile = Join-Path $repoRoot 'scripts/sync-to-instance.ps1'
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($sourceFile, [ref]$tokens, [ref]$parseErrors)
  Assert-Condition ($parseErrors.Count -eq 0) 'Sync script has PowerShell syntax errors'
  $transport = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq 'Invoke-SshRestore'
  }, $true)
  Assert-Condition ($null -ne $transport) 'SSH transport function was not found'
  $mockTransport = @'
function Invoke-SshRestore([string]$dumpPath) {
  $global:SyncVerificationCommands.Add('ssh-restore')
  if ((Get-Item -LiteralPath $dumpPath).Length -ne 30000) { throw 'Unexpected dump upload' }
  if ($global:SyncVerificationScenario -eq 'restore-failure') { throw 'mock restore failed' }
  return 'RESTORE_OK'
}
'@
  $source = [IO.File]::ReadAllText($sourceFile)
  $source = $source.Substring(0, $transport.Extent.StartOffset) + $mockTransport +
    $source.Substring($transport.Extent.EndOffset)
  $fixtureScript = Join-Path $fixtureRoot 'scripts/sync-to-instance.ps1'
  [IO.File]::WriteAllText($fixtureScript, $source)
  $env:OLX_INSTANCE_HOST = 'fixture.invalid'
  $env:OLX_SSH_USER = 'fixture-user'
  $env:OLX_SYNC_KEY = Join-Path $fixtureRoot 'fixture-key'
  $env:OLX_KNOWN_HOSTS_FILE = ''
  [IO.File]::WriteAllText($env:OLX_SYNC_KEY, 'fixture-key')
  $failure = $null
  try { & $fixtureScript | Out-Null } catch { $failure = $_ }

  $commands = $global:SyncVerificationCommands
  $buildAt = $commands.IndexOf('compose --profile scrape build scraper migrator')
  $stopAt = $commands.IndexOf('compose --profile scrape stop scraper')
  $scrapeAt = $commands.IndexOf('compose --profile scrape run --rm scraper node src/index.js --once')
  $resumeAt = $commands.IndexOf('compose --profile scrape start scraper')
  $restoreAt = $commands.IndexOf('ssh-restore')
  Assert-Condition ($buildAt -ge 0) 'Images were not rebuilt'
  if ($Scenario -eq 'build-failure') {
    Assert-Condition ($failure.Exception.Message -match 'image build failed') 'Build failure was not propagated'
    Assert-Condition ($stopAt -eq -1 -and $scrapeAt -eq -1 -and $restoreAt -eq -1) 'Failed build continued the sync'
  } else {
    $readyAt = $commands.IndexOf('compose up -d --wait db')
    $ownershipAt = $commands.IndexOf('compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh')
    Assert-Condition ($buildAt -lt $readyAt -and $readyAt -lt $ownershipAt -and $ownershipAt -lt $stopAt) "Build/database/ownership order changed: $($commands -join '; '); failure=$failure"
    Assert-Condition ($stopAt -lt $scrapeAt -and $scrapeAt -lt $resumeAt) 'Scraper was not paused and restored around sync'
    Assert-Condition (($commands | Where-Object { $_ -eq 'compose --profile scrape start scraper' }).Count -eq 1) 'Scraper must resume exactly once'
    if ($Scenario -eq 'success') {
      Assert-Condition ($null -eq $failure) "Successful sync failed: $failure"
      Assert-Condition ($scrapeAt -lt $restoreAt -and $restoreAt -lt $resumeAt) 'Restore ran outside the paused snapshot window'
    } else {
      Assert-Condition ($null -ne $failure) 'Failure did not abort sync'
      if ($Scenario -in @('scrape-failure', 'dump-failure')) {
        Assert-Condition ($restoreAt -eq -1) 'Failed local collection or dump contacted the instance'
      } else {
        Assert-Condition ($restoreAt -ge 0 -and $restoreAt -lt $resumeAt) 'Remote failure did not resume the scraper'
      }
    }
  }
  Write-Output "Sync workflow verified: $Scenario"
} finally {
  Set-Location $originalLocation
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedFixture) -notlike 'olx-sync-test-*') {
    throw 'Unexpected fixture cleanup path'
  }
  if (Test-Path -LiteralPath $resolvedFixture) {
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
  }
  Remove-Item -LiteralPath 'Function:\docker' -ErrorAction SilentlyContinue
}
