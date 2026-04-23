param(
  [string]$Date,
  [int]$Tail = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$observabilityDir = Join-Path $repoRoot ".observability"

function Resolve-TargetEventsFile {
  param(
    [string]$ObservabilityDir,
    [string]$RequestedDate
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedDate)) {
    $normalizedDate = $RequestedDate -replace '-', ''
    $candidate = Join-Path $ObservabilityDir "events-$normalizedDate.jsonl"
    if (-not (Test-Path -LiteralPath $candidate)) {
      throw "Requested events file not found for date $RequestedDate"
    }
    return $candidate
  }

  while ($true) {
    $files = Get-ChildItem -LiteralPath $ObservabilityDir -Filter "events-*.jsonl" -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^events-\d{8}\.jsonl$' } |
      Sort-Object Name

    if ($files.Count -gt 0) {
      return ($files | Select-Object -Last 1).FullName
    }

    Start-Sleep -Milliseconds 500
  }
}

function Format-EventLine {
  param(
    [string]$Line
  )

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $null
  }

  try {
    $event = $Line | ConvertFrom-Json
    $parts = @(
      $event.ts_wall
      $event.event
      "source=$($event.query_source)"
      "action=$($event.user_action_id)"
      "query=$($event.query_id)"
      "turn=$($event.turn_id)"
      "subagent=$($event.subagent_id)"
      "reason=$($event.subagent_reason)"
      "tool=$($event.tool_call_id)"
    )
    return ($parts -join " | ")
  } catch {
    return $Line
  }
}

$targetFile = Resolve-TargetEventsFile -ObservabilityDir $observabilityDir -RequestedDate $Date
Write-Output "正在监听: $targetFile"

if ($Tail -gt 0) {
  Get-Content -LiteralPath $targetFile -Tail $Tail | ForEach-Object {
    $formatted = Format-EventLine -Line $_
    if ($null -ne $formatted) {
      Write-Output $formatted
    }
  }
}

Get-Content -LiteralPath $targetFile -Wait | ForEach-Object {
  $formatted = Format-EventLine -Line $_
  if ($null -ne $formatted) {
    Write-Output $formatted
  }
}
