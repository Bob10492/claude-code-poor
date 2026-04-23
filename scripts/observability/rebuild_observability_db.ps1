param(
  [string]$Date,
  [string]$EventsFile,
  [switch]$Quiet
)

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$etlScript = Join-Path $repoRoot "scripts\observability\build_duckdb_etl.ts"
$duckdbExe = Join-Path $repoRoot "tools\duckdb\duckdb.exe"
$dbPath = Join-Path $repoRoot ".observability\observability_v1.duckdb"
$sqlPath = Join-Path $repoRoot ".observability\load_observability_v1.sql"

if (-not (Test-Path -LiteralPath $duckdbExe)) {
  throw "DuckDB executable not found at $duckdbExe"
}

$etlArgs = @("run", $etlScript)
if (-not [string]::IsNullOrWhiteSpace($EventsFile)) {
  $etlArgs += @("--events-file", $EventsFile)
} elseif (-not [string]::IsNullOrWhiteSpace($Date)) {
  $etlArgs += @("--date", $Date)
}

$etlOutput = & bun @etlArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not $Quiet) {
  Write-Output $etlOutput
}

& $duckdbExe -batch $dbPath -f $sqlPath
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not $Quiet) {
  & $duckdbExe -json $dbPath "select source_events_file_name, source_events_size_bytes, events_row_count, built_at from build_meta limit 1; select event_date, event_count, user_action_count, query_count, turn_count, tool_call_count, subagent_count, snapshot_ref_count from daily_rollups order by event_date desc limit 1;"
}
