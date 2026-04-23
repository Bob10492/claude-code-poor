param(
  [switch]$KeepSnapshots
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$observabilityDir = Join-Path $repoRoot ".observability"
$snapshotsDir = Join-Path $observabilityDir "snapshots"

if (-not (Test-Path -LiteralPath $observabilityDir)) {
  throw "Observability directory not found at $observabilityDir"
}

$eventFiles = @(Get-ChildItem -LiteralPath $observabilityDir -Filter "events-*.jsonl" -File -ErrorAction SilentlyContinue)
$dbFiles = @(
  Join-Path $observabilityDir "observability_v1.duckdb"
  Join-Path $observabilityDir "load_observability_v1.sql"
) | Where-Object { Test-Path -LiteralPath $_ }

$snapshotFiles = @()
if ((-not $KeepSnapshots) -and (Test-Path -LiteralPath $snapshotsDir)) {
  $snapshotFiles = @(Get-ChildItem -LiteralPath $snapshotsDir -File -Force -ErrorAction SilentlyContinue)
}

foreach ($file in $eventFiles) {
  Remove-Item -LiteralPath $file.FullName -Force
}

foreach ($file in $dbFiles) {
  Remove-Item -LiteralPath $file -Force
}

foreach ($file in $snapshotFiles) {
  Remove-Item -LiteralPath $file.FullName -Force
}

if (-not (Test-Path -LiteralPath $snapshotsDir)) {
  New-Item -ItemType Directory -Path $snapshotsDir | Out-Null
}

Write-Output "已清空可观测调试数据:"
Write-Output "  删除事件文件: $($eventFiles.Count)"
Write-Output "  删除数据库/SQL 文件: $($dbFiles.Count)"
Write-Output "  删除 snapshots: $($snapshotFiles.Count)"
Write-Output "  snapshots 目录保留: $snapshotsDir"
