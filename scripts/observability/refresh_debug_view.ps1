param(
  [string]$Date,
  [string]$EventsFile,
  [switch]$SummaryOnly
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rebuildScript = Join-Path $repoRoot "scripts\observability\rebuild_observability_db.ps1"
$summaryScript = Join-Path $repoRoot "scripts\observability\daily_summary.ps1"
$dashboardScript = Join-Path $repoRoot "scripts\observability\build_dashboard.ps1"

$commonArgs = @("-ExecutionPolicy", "Bypass")

$rebuildArgs = @($commonArgs + @("-File", $rebuildScript))
if (-not [string]::IsNullOrWhiteSpace($EventsFile)) {
  $rebuildArgs += @("-EventsFile", $EventsFile)
} elseif (-not [string]::IsNullOrWhiteSpace($Date)) {
  $rebuildArgs += @("-Date", $Date)
}

& powershell @rebuildArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$summaryArgs = @($commonArgs + @("-File", $summaryScript, "-SkipRebuild"))
if (-not [string]::IsNullOrWhiteSpace($EventsFile)) {
  $summaryArgs += @("-EventsFile", $EventsFile)
} elseif (-not [string]::IsNullOrWhiteSpace($Date)) {
  $summaryArgs += @("-Date", $Date)
}

& powershell @summaryArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($SummaryOnly) {
  exit 0
}

$dashboardArgs = @($commonArgs + @("-File", $dashboardScript, "-SkipRebuild"))
if (-not [string]::IsNullOrWhiteSpace($EventsFile)) {
  $dashboardArgs += @("-EventsFile", $EventsFile)
} elseif (-not [string]::IsNullOrWhiteSpace($Date)) {
  $dashboardArgs += @("-Date", $Date)
}

& powershell @dashboardArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
