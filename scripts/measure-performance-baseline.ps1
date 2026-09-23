$ErrorActionPreference = "Stop"

# Stage 1 only: execute the provisioned overview targets through Grafana's
# datasource API. This deliberately does not change dashboard SQL or server
# resource limits.

$databaseContainer = "pik-market-watch-db-1"
$grafanaUrl = "http://127.0.0.1:3000"
$refreshesPerScenario = 1

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

function Reset-StatementStats {
  Invoke-Psql "SELECT pg_stat_statements_reset();" | Out-Null
}

function Get-StatementStats {
  $sql = @"
SELECT COALESCE(sum(calls), 0),
       COALESCE(sum(total_exec_time), 0),
       COALESCE(sum(rows), 0),
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY mean_exec_time), 0)
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT ILIKE '%pg_stat_statements%'
  AND query NOT ILIKE '%current_database%';
"@
  $parts = (Invoke-Psql $sql).Split("|")
  [pscustomobject]@{
    sql_requests = [int64]$parts[0]
    total_sql_ms = [double]$parts[1]
    rows_returned = [int64]$parts[2]
    approximate_p95_statement_mean_ms = [double]$parts[3]
  }
}

function Get-Quantile([double[]]$values, [double]$quantile) {
  if (!$values -or $values.Count -eq 0) { return 0 }
  $ordered = @($values | Sort-Object)
  $index = [math]::Max(0, [math]::Ceiling($quantile * $ordered.Count) - 1)
  return [double]$ordered[$index]
}

function Sql-LiteralList([string[]]$values) {
  return (($values | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ",")
}

$envMap = Read-DotEnv
$adminUser = if ($envMap.GRAFANA_ADMIN_USER) { $envMap.GRAFANA_ADMIN_USER } else { "admin" }
$auth = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("$adminUser`:$($envMap.GRAFANA_ADMIN_PASSWORD)")
)
$headers = @{ Authorization = "Basic $auth" }
$dashboard = Get-Content (Join-Path $PSScriptRoot "..\grafana\dashboards\olx-overview.json") -Raw | ConvertFrom-Json

$allNeighborhoodSql = @"
SELECT string_agg(quote_literal(value), ',' ORDER BY value)
FROM (
  SELECT neighborhood AS value FROM reporting.daily_listing_facts WHERE neighborhood IS NOT NULL
  UNION SELECT location FROM reporting.daily_listing_facts WHERE location IS NOT NULL
  UNION SELECT COALESCE(NULLIF(location, ''), CASE WHEN latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
    FROM reporting.dashboard_listings
  UNION SELECT '(no pin)'
  UNION SELECT '(unmapped)'
) values;
"@
$allNeighborhood = Invoke-Psql $allNeighborhoodSql

$allCategory = Sql-LiteralList @("apartments", "houses", "vacation_homes")
$allDeal = Sql-LiteralList @("sell", "rent")
$allRooms = Sql-LiteralList @("0", "1", "2", "3", "4+")

$scenarios = @(
  [pscustomobject]@{ name = "default-90d"; category = $allCategory; deal = $allDeal; rooms = $allRooms; neighborhood = $allNeighborhood; from = "now-90d" }
  [pscustomobject]@{ name = "sale-only-90d"; category = $allCategory; deal = (Sql-LiteralList @("sell")); rooms = $allRooms; neighborhood = $allNeighborhood; from = "now-90d" }
  [pscustomobject]@{ name = "rent-only-90d"; category = $allCategory; deal = (Sql-LiteralList @("rent")); rooms = $allRooms; neighborhood = $allNeighborhood; from = "now-90d" }
  [pscustomobject]@{ name = "apartments-90d"; category = (Sql-LiteralList @("apartments")); deal = $allDeal; rooms = $allRooms; neighborhood = $allNeighborhood; from = "now-90d" }
  [pscustomobject]@{ name = "centar-1-90d"; category = $allCategory; deal = $allDeal; rooms = $allRooms; neighborhood = (Sql-LiteralList @("Centar 1")); from = "now-90d" }
  [pscustomobject]@{ name = "two-rooms-90d"; category = $allCategory; deal = $allDeal; rooms = (Sql-LiteralList @("2")); neighborhood = $allNeighborhood; from = "now-90d" }
  [pscustomobject]@{ name = "apartments-centar-1-two-rooms-90d"; category = (Sql-LiteralList @("apartments")); deal = $allDeal; rooms = (Sql-LiteralList @("2")); neighborhood = (Sql-LiteralList @("Centar 1")); from = "now-90d" }
  [pscustomobject]@{ name = "default-30d"; category = $allCategory; deal = $allDeal; rooms = $allRooms; neighborhood = $allNeighborhood; from = "now-30d" }
)

$queryVariables = @($dashboard.templating.list | Where-Object { $_.type -eq "query" })
$panelTargets = @(
  foreach ($panel in $dashboard.panels) {
    foreach ($target in @($panel.targets)) {
      if ($target.rawSql) {
        [pscustomobject]@{ panel = $panel.id; target = $target }
      }
    }
  }
)

$results = @()
foreach ($scenario in $scenarios) {
  Reset-StatementStats
  $wallTimes = @()
  $sqlErrors = 0
  $monitor = Start-Job -ArgumentList $databaseContainer -ScriptBlock {
    param($container)
    while ($true) {
      docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' $container
      Start-Sleep -Milliseconds 500
    }
  }

  try {
    for ($run = 1; $run -le $refreshesPerScenario; $run++) {
      $stopwatch = [Diagnostics.Stopwatch]::StartNew()

      foreach ($variable in $queryVariables) {
        $variableQuery = @{
          refId = "V$($run)$($variable.name)"
          datasource = @{ type = "postgres"; uid = "olx-postgres" }
          rawSql = $variable.query
          format = "table"
          intervalMs = 15000
          maxDataPoints = 1000
        }
        $payload = @{ queries = @($variableQuery); from = $scenario.from; to = "now" } |
          ConvertTo-Json -Depth 20
        try {
          Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $payload | Out-Null
        } catch {
          $sqlErrors++
        }
      }

      foreach ($entry in $panelTargets) {
        $sql = $entry.target.rawSql
        $sql = $sql.Replace('${category:sqlstring}', $scenario.category)
        $sql = $sql.Replace('${deal:sqlstring}', $scenario.deal)
        $sql = $sql.Replace('${rooms:sqlstring}', $scenario.rooms)
        $sql = $sql.Replace('${neighborhood:sqlstring}', $scenario.neighborhood)
        $sql = $sql.Replace('${min_sqm:sqlstring}', "'0'")
        $sql = $sql.Replace('${max_sqm:sqlstring}', "'99999'")
        $query = [ordered]@{
          refId = "P$($run)_$($entry.panel)_$($entry.target.refId)"
          datasource = @{ type = "postgres"; uid = "olx-postgres" }
          rawSql = $sql
          format = if ($entry.target.format) { $entry.target.format } else { "table" }
          intervalMs = 15000
          maxDataPoints = 1000
        }
        $payload = @{ queries = @($query); from = $scenario.from; to = "now" } | ConvertTo-Json -Depth 20
        try {
          Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $payload | Out-Null
        } catch {
          $sqlErrors++
        }
      }
      $stopwatch.Stop()
      $wallTimes += $stopwatch.Elapsed.TotalMilliseconds
    }
  } finally {
    Stop-Job $monitor -ErrorAction SilentlyContinue | Out-Null
  }

  $stats = Get-StatementStats
  $samples = @(Receive-Job $monitor -ErrorAction SilentlyContinue)
  Remove-Job $monitor -Force -ErrorAction SilentlyContinue
  $cpu = @($samples | ForEach-Object {
    $parts = ([string]$_).Split("|")
    if ($parts.Count -eq 4) {
      [pscustomobject]@{ cpu = [double]($parts[1].TrimEnd('%')); memory = $parts[2]; memory_percent = [double]($parts[3].TrimEnd('%')) }
    }
  })

  $results += [pscustomobject]@{
    scenario = $scenario.name
    refreshes = $refreshesPerScenario
    sql_errors = $sqlErrors
    dashboard_load_ms_mean = [math]::Round((($wallTimes | Measure-Object -Average).Average), 1)
    dashboard_load_ms_p95 = [math]::Round((Get-Quantile $wallTimes 0.95), 1)
    sql_requests_per_refresh = [math]::Round($stats.sql_requests / $refreshesPerScenario, 1)
    mean_sql_ms = [math]::Round($stats.total_sql_ms / [math]::Max(1, $stats.sql_requests), 3)
    approximate_p95_sql_ms = [math]::Round($stats.approximate_p95_statement_mean_ms, 3)
    rows_returned_per_refresh = [math]::Round($stats.rows_returned / $refreshesPerScenario, 1)
    database_cpu_percent_max_sample = if ($cpu.Count) { [math]::Round((($cpu.cpu | Measure-Object -Maximum).Maximum), 2) } else { $null }
    database_memory_samples = @($cpu.memory | Select-Object -Unique)
    database_memory_percent_max_sample = if ($cpu.Count) { [math]::Round((($cpu.memory_percent | Measure-Object -Maximum).Maximum), 2) } else { $null }
  }
}

$results | ConvertTo-Json -Depth 8
