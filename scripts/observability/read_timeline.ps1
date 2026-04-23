param(
  [string]$UserActionId,
  [string]$QueryId,
  [string]$SubagentId
)

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$duckdbExe = Join-Path $repoRoot "tools\duckdb\duckdb.exe"
$dbPath = Join-Path $repoRoot ".observability\observability_v1.duckdb"

if (-not (Test-Path -LiteralPath $duckdbExe)) {
  throw "DuckDB executable not found at $duckdbExe"
}

if (-not (Test-Path -LiteralPath $dbPath)) {
  throw "DuckDB database not found at $dbPath"
}

$provided = @($UserActionId, $QueryId, $SubagentId | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ($provided -ne 1) {
  throw "Pass exactly one of -UserActionId, -QueryId, or -SubagentId"
}

$whereClause = if (-not [string]::IsNullOrWhiteSpace($UserActionId)) {
  "user_action_id = '$UserActionId'"
} elseif (-not [string]::IsNullOrWhiteSpace($QueryId)) {
  "coalesce(effective_query_id, query_id) = '$QueryId'"
} else {
  "subagent_id = '$SubagentId'"
}

$sql = @"
select
  ts_wall,
  event_name,
  query_source,
  coalesce(effective_query_id, query_id) as effective_query_id,
  turn_id,
  subagent_id,
  tool_call_id,
  payload_json
from events_raw
where $whereClause
order by ts_wall_ms asc, event_idx asc;
"@

$rows = (& $duckdbExe -json $dbPath $sql) | ConvertFrom-Json

function Summarize-Payload {
  param(
    [string]$EventName,
    [object]$PayloadText
  )

  if ([string]::IsNullOrWhiteSpace($PayloadText)) {
    return ""
  }

  $payload = $PayloadText | ConvertFrom-Json
  switch ($EventName) {
    "prompt.build.completed" {
      return "model=$($payload.model), system_prompt_chars=$($payload.system_prompt_chars), messages_chars_total=$($payload.messages_chars_total), claude_md_chars=$($payload.claude_md_chars)"
    }
    "api.stream.completed" {
      return "stop_reason=$($payload.stop_reason), assistant_message_count=$($payload.assistant_message_count), tool_use_count=$($payload.tool_use_count)"
    }
    "tool.execution.completed" {
      return "tool_name=$($payload.tool_name), success=$($payload.success), duration_ms=$($payload.duration_ms)"
    }
    "tool.execution.failed" {
      return "tool_name=$($payload.tool_name), duration_ms=$($payload.duration_ms), error=$($payload.error_name)"
    }
    "state.transitioned" {
      return "to_transition=$($payload.to_transition), message_delta=$($payload.message_delta), token_before=$($payload.token_estimate_before), token_after=$($payload.token_estimate_after)"
    }
    "query.terminated" {
      return "reason=$($payload.reason), final_message_count=$($payload.final_message_count)"
    }
    "subagent.spawned" {
      return "fork_label=$($payload.fork_label), inherited_message_count=$($payload.inherited_message_count), transcript_enabled=$($payload.transcript_enabled)"
    }
    "subagent.completed" {
      return "message_count=$($payload.message_count), transcript_enabled=$($payload.transcript_enabled)"
    }
    default {
      $json = $PayloadText
      if ($json.Length -gt 140) {
        return $json.Substring(0, 140) + "..."
      }
      return $json
    }
  }
}

foreach ($row in @($rows)) {
  $summary = Summarize-Payload -EventName $row.event_name -PayloadText $row.payload_json
  $base = "{0} | {1} | query={2} | turn={3} | subagent={4} | tool={5}" -f $row.ts_wall, $row.event_name, $row.effective_query_id, $row.turn_id, $row.subagent_id, $row.tool_call_id
  if ([string]::IsNullOrWhiteSpace($summary)) {
    Write-Output $base
  } else {
    Write-Output "$base | $summary"
  }
}
