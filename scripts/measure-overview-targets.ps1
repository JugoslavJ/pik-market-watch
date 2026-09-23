$ErrorActionPreference = "Stop"

$databaseContainer = "pik-market-watch-db-1"
$grafanaUrl = "http://127.0.0.1:3000"

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

$envMap = Read-DotEnv
$adminUser = if ($envMap.GRAFANA_ADMIN_USER) { $envMap.GRAFANA_ADMIN_USER } else { "admin" }
$auth = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("$adminUser`:$($envMap.GRAFANA_ADMIN_PASSWORD)")
)
$headers = @{ Authorization = "Basic $auth" }
$allCategories = Sql-LiteralList @("apartments", "houses", "vacation_homes")
$allDeal = Sql-LiteralList @("sell", "rent")
$allRooms = Sql-LiteralList @("0", "1", "2", "3", "4+")

$currentTemplate = @'
SELECT count(*) AS active
FROM reporting.listings_filtered(ARRAY[CATEGORY]::text[], reporting.dashboard_numeric('0'), reporting.dashboard_numeric('99999'), NEIGHBORHOOD) l
WHERE reporting.room_bucket(l.rooms) = ANY (ARRAY[ROOMS]::text[])
  AND CASE WHEN l.is_rent THEN 'rent' ELSE 'sell' END = ANY (ARRAY[DEAL]::text[])
'@

$historicalTemplate = @'
SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       p25 AS "p25 KM/m2", median AS "median KM/m2", p75 AS "p75 KM/m2",
       inventory_count AS inventory, priced_count AS "priced sample",
       estimated_count AS estimated, stale_count AS stale, provisional_day AS provisional
FROM reporting.market_daily_filtered(
  date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo'),
  date($__timeTo() AT TIME ZONE 'Europe/Sarajevo'),
  ARRAY[CATEGORY]::text[], reporting.dashboard_numeric('0'),
  reporting.dashboard_numeric('99999'), ARRAY[ROOMS]::text[],
  ARRAY(SELECT CASE WHEN selected = 'sell' THEN 'sale' ELSE selected END
        FROM unnest(ARRAY[DEAL]::text[]) AS t(selected)), ARRAY[]::text[])
ORDER BY day
'@

$cases = @(
  [pscustomobject]@{ name = "default-90d-active-target"; sql = $currentTemplate.Replace("CATEGORY", $allCategories).Replace("NEIGHBORHOOD", "ARRAY[]::text[]").Replace("ROOMS", $allRooms).Replace("DEAL", $allDeal); from = "now-90d" }
  [pscustomobject]@{ name = "sale-only-active-target"; sql = $currentTemplate.Replace("CATEGORY", $allCategories).Replace("NEIGHBORHOOD", "ARRAY[]::text[]").Replace("ROOMS", $allRooms).Replace("DEAL", (Sql-LiteralList @("sell"))); from = "now-90d" }
  [pscustomobject]@{ name = "rent-only-active-target"; sql = $currentTemplate.Replace("CATEGORY", $allCategories).Replace("NEIGHBORHOOD", "ARRAY[]::text[]").Replace("ROOMS", $allRooms).Replace("DEAL", (Sql-LiteralList @("rent"))); from = "now-90d" }
  [pscustomobject]@{ name = "one-category-active-target"; sql = $currentTemplate.Replace("CATEGORY", (Sql-LiteralList @("apartments"))).Replace("NEIGHBORHOOD", "ARRAY[]::text[]").Replace("ROOMS", $allRooms).Replace("DEAL", $allDeal); from = "now-90d" }
  [pscustomobject]@{ name = "one-neighborhood-active-target"; sql = $currentTemplate.Replace("CATEGORY", $allCategories).Replace("NEIGHBORHOOD", "ARRAY['Centar 1']::text[]").Replace("ROOMS", $allRooms).Replace("DEAL", $allDeal); from = "now-90d" }
  [pscustomobject]@{ name = "one-room-bucket-active-target"; sql = $currentTemplate.Replace("CATEGORY", $allCategories).Replace("NEIGHBORHOOD", "ARRAY[]::text[]").Replace("ROOMS", (Sql-LiteralList @("2"))).Replace("DEAL", $allDeal); from = "now-90d" }
  [pscustomobject]@{ name = "category-neighborhood-rooms-active-target"; sql = $currentTemplate.Replace("CATEGORY", (Sql-LiteralList @("apartments"))).Replace("NEIGHBORHOOD", "ARRAY['Centar 1']::text[]").Replace("ROOMS", (Sql-LiteralList @("2"))).Replace("DEAL", $allDeal); from = "now-90d" }
  [pscustomobject]@{ name = "historical-30d-target"; sql = $historicalTemplate.Replace("CATEGORY", $allCategories).Replace("ROOMS", $allRooms).Replace("DEAL", $allDeal); from = "now-30d" }
  [pscustomobject]@{ name = "historical-90d-target"; sql = $historicalTemplate.Replace("CATEGORY", $allCategories).Replace("ROOMS", $allRooms).Replace("DEAL", $allDeal); from = "now-90d" }
)

$results = foreach ($case in $cases) {
  Invoke-Psql "SELECT pg_stat_statements_reset();" | Out-Null
  $query = [ordered]@{
    refId = "A"
    datasource = @{ type = "postgres"; uid = "olx-postgres" }
    rawSql = $case.sql
    format = "table"
    intervalMs = 15000
    maxDataPoints = 1000
  }
  $payload = @{ queries = @($query); from = $case.from; to = "now" } | ConvertTo-Json -Depth 20
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Method Post -Uri "$grafanaUrl/api/ds/query" -Headers $headers -ContentType "application/json" -Body $payload
  $clock.Stop()
  $stats = (Invoke-Psql @"
SELECT calls, total_exec_time, rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC LIMIT 1;
"@).Split("|")
  [pscustomobject]@{
    case = $case.name
    grafana_target_ms = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    sql_calls = [int64]$stats[0]
    sql_total_ms = [math]::Round([double]$stats[1], 3)
    sql_rows = [int64]$stats[2]
    response_error = @($response.results.PSObject.Properties.Value | Where-Object { $_.error } | ForEach-Object error)
  }
}

$results | ConvertTo-Json -Depth 8
