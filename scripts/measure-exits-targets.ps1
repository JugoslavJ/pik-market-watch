$ErrorActionPreference = "Stop"

$databaseContainer = "pik-market-watch-db-1"
$grafanaUrl = "http://127.0.0.1:3000"
$dashboardPath = Join-Path $PSScriptRoot "..\grafana\dashboards\olx-exits.json"

function Read-DotEnv {
  $values = @{}
  Get-Content (Join-Path $PSScriptRoot "..\.env") | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
  }
  return $values
}

function Invoke-Psql([string]$sql) {
  $output = docker exec $databaseContainer psql -U olx -d olx -At -F "|" -c $sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed" }
  return ($output -join "`n").Trim()
}

function Sql-LiteralList([string[]]$values) {
  return (($values | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ",")
}

function Convert-Target([object]$target, [hashtable]$filters) {
  $sql = $target.rawSql
  foreach ($name in @("category", "rooms", "deal", "neighborhood")) {
    $sql = $sql.Replace('${' + $name + ':sqlstring}', $filters[$name])
  }
  $sql = $sql.Replace('${min_sqm:sqlstring}', $filters.min_sqm)
  $sql = $sql.Replace('${max_sqm:sqlstring}', $filters.max_sqm)
  return $sql
}

function Convert-TimeMacros([string]$sql, [DateTimeOffset]$from, [DateTimeOffset]$to) {
  $fromLiteral = $from.ToString("yyyy-MM-dd HH:mm:ss.fffzzz")
  $toLiteral = $to.ToString("yyyy-MM-dd HH:mm:ss.fffzzz")
  $sql = [regex]::Replace($sql, '\$__timeFilter\(([^)]+)\)', {
    param($match)
    return "$($match.Groups[1].Value) BETWEEN '$fromLiteral' AND '$toLiteral'"
  })
  $sql = $sql.Replace('$__timeFrom()', "'$fromLiteral'::timestamptz")
  $sql = $sql.Replace('$__timeTo()', "'$toLiteral'::timestamptz")
  return $sql
}

function Get-Explain([string]$sql) {
  $json = Invoke-Psql "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) $sql"
  return ,($json | ConvertFrom-Json -Depth 60)
}

function Get-ResultSummary([object]$response) {
  $serialized = $response | ConvertTo-Json -Depth 60 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($serialized)
  $sha = [Security.Cryptography.SHA256]::HashData($bytes)
  $results = @($response.results.PSObject.Properties | ForEach-Object { $_.Value })
  $rows = 0
  $errors = @()
  foreach ($result in $results) {
    if ($result.error) { $errors += $result.error }
    foreach ($frame in @($result.frames)) {
      if ($frame.data.values.Count -gt 0) {
        $rows += @($frame.data.values[0]).Count
      }
    }
  }
  return [pscustomobject]@{
    rows = $rows
    result_sha256 = [Convert]::ToHexString($sha).ToLowerInvariant()
    errors = $errors
  }
}

$envMap = Read-DotEnv
$adminUser = if ($envMap.GRAFANA_ADMIN_USER) { $envMap.GRAFANA_ADMIN_USER } else { "admin" }
$auth = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("$adminUser`:$($envMap.GRAFANA_ADMIN_PASSWORD)")
)
$headers = @{ Authorization = "Basic $auth" }
$dashboard = Get-Content $dashboardPath -Raw | ConvertFrom-Json
$fixedTo = [DateTimeOffset]::UtcNow

$optionRows = Invoke-Psql "SELECT filter_name, value FROM reporting.dashboard_filter_options ORDER BY filter_name, sort_order NULLS LAST, value"
$options = @{}
foreach ($line in ($optionRows -split "`n")) {
  if ($line -match '^([^|]+)\|(.*)$') {
    if (-not $options.ContainsKey($matches[1])) { $options[$matches[1]] = [System.Collections.Generic.List[string]]::new() }
    $options[$matches[1]].Add($matches[2])
  }
}
$allFilters = @{
  category = Sql-LiteralList $options.category.ToArray()
  rooms = Sql-LiteralList $options.room_bucket.ToArray()
  deal = Sql-LiteralList @("sell", "rent")
  neighborhood = Sql-LiteralList $options.neighborhood.ToArray()
  min_sqm = "'0'"
  max_sqm = "'99999'"
}
$cases = @(
  [pscustomobject]@{ name = "default-90d"; filters = $allFilters; from = $fixedTo.AddDays(-90); to = $fixedTo }
  [pscustomobject]@{ name = "selective-90d"; filters = @{ category = "'apartments'"; rooms = "'2'"; deal = "'sell'"; neighborhood = "'Borik 1'"; min_sqm = "'0'"; max_sqm = "'99999'" }; from = $fixedTo.AddDays(-90); to = $fixedTo }
  [pscustomobject]@{ name = "long-365d"; filters = $allFilters; from = $fixedTo.AddDays(-365); to = $fixedTo }
)

$targets = foreach ($panel in $dashboard.panels) {
  foreach ($target in @($panel.targets)) {
    if ($target.rawSql) {
      [pscustomobject]@{ id = $panel.id; title = $panel.title; target = $target }
    }
  }
}
$variableQueries = @($dashboard.templating.list | Where-Object { $_.type -eq "query" })
$measurements = [System.Collections.Generic.List[object]]::new()
$plans = [System.Collections.Generic.List[object]]::new()

foreach ($case in $cases) {
  $fromMs = $case.from.ToUnixTimeMilliseconds()
  $toMs = $case.to.ToUnixTimeMilliseconds()
  $apiQueries = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in $targets) {
    $query = @{
      refId = "A"
      datasource = @{ type = "postgres"; uid = "olx-postgres" }
      rawSql = Convert-Target $entry.target $case.filters
      format = $entry.target.format
      intervalMs = 15000
      maxDataPoints = 1000
    }
    $batchQuery = $query.Clone()
    $batchQuery.refId = "P$($entry.id)_$($entry.target.refId)"
    $apiQueries.Add($batchQuery)

    $payload = @{ queries = @($query); from = "$fromMs"; to = "$toMs" } | ConvertTo-Json -Depth 30
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $payload
    $clock.Stop()
    $summary = Get-ResultSummary $response
    $measurements.Add([pscustomobject]@{
      case = $case.name; kind = "target"; panel_id = $entry.id; target = $entry.target.refId
      grafana_ms = [math]::Round($clock.Elapsed.TotalMilliseconds, 1); rows = $summary.rows
      result_sha256 = $summary.result_sha256; errors = $summary.errors
    })
  }

  $batchPayload = @{ queries = $apiQueries.ToArray(); from = "$fromMs"; to = "$toMs" } | ConvertTo-Json -Depth 40
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $batchResponse = Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $batchPayload
  $clock.Stop()
  $batchSummary = Get-ResultSummary $batchResponse
  $measurements.Add([pscustomobject]@{
    case = $case.name; kind = "dashboard-query-batch"; panel_id = $null; target = $null
    grafana_ms = [math]::Round($clock.Elapsed.TotalMilliseconds, 1); rows = $batchSummary.rows
    result_sha256 = $batchSummary.result_sha256; errors = $batchSummary.errors
  })
}

foreach ($variable in $variableQueries) {
  $query = @{
    refId = "A"
    datasource = @{ type = "postgres"; uid = "olx-postgres" }
    rawSql = $variable.query
    format = "table"
    intervalMs = 15000
    maxDataPoints = 1000
  }
  $payload = @{ queries = @($query); from = "now-90d"; to = "now" } | ConvertTo-Json -Depth 20
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $payload
  $clock.Stop()
  $summary = Get-ResultSummary $response
  $measurements.Add([pscustomobject]@{
    case = "dropdown-options"; kind = "dropdown"; panel_id = $null; target = $variable.name
    grafana_ms = [math]::Round($clock.Elapsed.TotalMilliseconds, 1); rows = $summary.rows
    result_sha256 = $summary.result_sha256; errors = $summary.errors
  })
}

$planTargets = @($targets | Where-Object {
  $_.id -in @(1, 2, 3, 4, 6, 16, 19, 20) -and
    ($_.id -ne 6 -or $_.target.refId -eq "B")
})
$defaultCase = $cases | Where-Object name -eq "default-90d"
foreach ($entry in $planTargets) {
  $sql = Convert-TimeMacros (Convert-Target $entry.target $defaultCase.filters) $defaultCase.from $defaultCase.to
  $plans.Add([pscustomobject]@{
    name = "panel-$($entry.id)-$($entry.target.refId)"
    explain_analyze_buffers = Get-Explain $sql
  })
}
foreach ($variable in $variableQueries) {
  $plans.Add([pscustomobject]@{
    name = "dropdown-$($variable.name)"
    explain_analyze_buffers = Get-Explain $variable.query
  })
}

$report = [pscustomobject]@{
  captured_at_utc = $fixedTo.ToString("o")
  database = Invoke-Psql "SELECT current_database() || '|' || current_setting('server_version') || '|' || pg_database_size(current_database())"
  default_time_range = $dashboard.time
  fixed_time_to_utc = $fixedTo.ToString("o")
  target_count = $targets.Count
  measurements = $measurements
  plans = $plans
}
$json = $report | ConvertTo-Json -Depth 60
$outputPath = Join-Path $PSScriptRoot "..\backups\exits-dashboard-baseline-$($fixedTo.ToString('yyyyMMdd-HHmmss')).json"
Set-Content -LiteralPath $outputPath -Value $json -Encoding utf8
Write-Output "Baseline saved to $outputPath"
$measurements |
  Where-Object { $_.kind -in @("dashboard-query-batch", "dropdown") } |
  Select-Object case, kind, target, grafana_ms, rows, errors |
  ConvertTo-Json -Depth 8
