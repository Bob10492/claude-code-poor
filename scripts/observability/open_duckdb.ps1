$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$duckdbExe = Join-Path $repoRoot "tools\\duckdb\\duckdb.exe"
$dbPath = Join-Path $repoRoot ".observability\\observability_v1.duckdb"

if (-not (Test-Path -LiteralPath $duckdbExe)) {
  throw "DuckDB executable not found at $duckdbExe"
}

& $duckdbExe $dbPath @Args
