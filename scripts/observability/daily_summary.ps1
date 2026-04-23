param(
  [string]$Date,
  [string]$EventsFile,
  [switch]$SkipRebuild
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$observabilityDir = Join-Path $repoRoot ".observability"
$duckdbExe = Join-Path $repoRoot "tools\duckdb\duckdb.exe"
$dbPath = Join-Path $repoRoot ".observability\observability_v1.duckdb"
$rebuildScript = Join-Path $repoRoot "scripts\observability\rebuild_observability_db.ps1"

if (-not (Test-Path -LiteralPath $duckdbExe)) {
  throw "DuckDB executable not found at $duckdbExe"
}

function Get-EpochMilliseconds {
  param(
    [datetime]$Value
  )

  return ([DateTimeOffset]$Value.ToUniversalTime()).ToUnixTimeMilliseconds()
}

function Resolve-TargetEventsFile {
  param(
    [string]$ObservabilityDir,
    [string]$RequestedDate,
    [string]$RequestedEventsFile
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedEventsFile)) {
    return (Resolve-Path -LiteralPath $RequestedEventsFile).Path
  }

  $files = Get-ChildItem -LiteralPath $ObservabilityDir -Filter "events-*.jsonl" |
    Where-Object { $_.Name -match '^events-\d{8}\.jsonl$' } |
    Sort-Object Name

  if (-not $files -or $files.Count -eq 0) {
    throw "No events-YYYYMMDD.jsonl files found in $ObservabilityDir"
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedDate)) {
    $normalizedDate = $RequestedDate -replace '-', ''
    $matched = $files | Where-Object { $_.BaseName -eq "events-$normalizedDate" } | Select-Object -First 1
    if (-not $matched) {
      throw "Requested events file not found for date $RequestedDate"
    }
    return $matched.FullName
  }

  return ($files | Select-Object -Last 1).FullName
}

function Get-TargetDate {
  param(
    [string]$RequestedDate,
    [string]$TargetEventsFile
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedDate)) {
    return $RequestedDate
  }

  $match = [regex]::Match([System.IO.Path]::GetFileName($TargetEventsFile), '^events-(\d{4})(\d{2})(\d{2})\.jsonl$')
  if ($match.Success) {
    return "$($match.Groups[1].Value)-$($match.Groups[2].Value)-$($match.Groups[3].Value)"
  }

  return $null
}

function Get-BuildMeta {
  param(
    [string]$DuckDbExe,
    [string]$DatabasePath
  )

  if (-not (Test-Path -LiteralPath $DatabasePath)) {
    return $null
  }

  $raw = & $DuckDbExe -json $DatabasePath "select * from build_meta limit 1;" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  return @($raw | ConvertFrom-Json)[0]
}

function Ensure-FreshDatabase {
  param(
    [string]$TargetEventsFile,
    [string]$RequestedDate,
    [string]$DuckDbExe,
    [string]$DatabasePath,
    [string]$RebuildScript,
    [switch]$SkipRebuild
  )

  $targetStat = Get-Item -LiteralPath $TargetEventsFile
  $targetMtimeMs = Get-EpochMilliseconds -Value $targetStat.LastWriteTimeUtc
  $buildMeta = Get-BuildMeta -DuckDbExe $DuckDbExe -DatabasePath $DatabasePath
  $isStale =
    ($null -eq $buildMeta) -or
    ($buildMeta.source_events_file -ne $TargetEventsFile) -or
    ([int64]$buildMeta.source_events_size_bytes -ne [int64]$targetStat.Length) -or
    ([int64]$buildMeta.source_events_mtime_ms -ne $targetMtimeMs)

  if (-not $isStale) {
    return
  }

  if ($SkipRebuild) {
    throw "Observability DB is stale for $TargetEventsFile and -SkipRebuild was provided."
  }

  $rebuildArgs = @("-ExecutionPolicy", "Bypass", "-File", $RebuildScript, "-Quiet")
  if (-not [string]::IsNullOrWhiteSpace($EventsFile)) {
    $rebuildArgs += @("-EventsFile", $TargetEventsFile)
  } elseif (-not [string]::IsNullOrWhiteSpace($RequestedDate)) {
    $rebuildArgs += @("-Date", $RequestedDate)
  }

  & powershell @rebuildArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Invoke-DuckDbJson {
  param(
    [string]$Sql
  )

  $raw = & $duckdbExe -json $dbPath $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "DuckDB query failed: $Sql"
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @()
  }
  return @($raw | ConvertFrom-Json)
}

$targetEventsFile = Resolve-TargetEventsFile -ObservabilityDir $observabilityDir -RequestedDate $Date -RequestedEventsFile $EventsFile
$targetDate = Get-TargetDate -RequestedDate $Date -TargetEventsFile $targetEventsFile

Ensure-FreshDatabase -TargetEventsFile $targetEventsFile -RequestedDate $Date -DuckDbExe $duckdbExe -DatabasePath $dbPath -RebuildScript $rebuildScript -SkipRebuild:$SkipRebuild

if (-not (Test-Path -LiteralPath $dbPath)) {
  throw "DuckDB database not found at $dbPath"
}

if ([string]::IsNullOrWhiteSpace($targetDate)) {
  $targetDate = (Invoke-DuckDbJson "select max(event_date) as event_date from daily_rollups;")[0].event_date
}

$buildMeta = (Invoke-DuckDbJson "select source_events_file_name, source_events_size_bytes, events_row_count, built_at from build_meta limit 1;")[0]
$rollup = (Invoke-DuckDbJson "select * from daily_rollups where event_date = '$targetDate' limit 1;")[0]
$integrity = (Invoke-DuckDbJson "select * from metrics_integrity_daily where event_date = '$targetDate' limit 1;")[0]
$cost = (Invoke-DuckDbJson "select * from metrics_cost_daily where event_date = '$targetDate' limit 1;")[0]
$loops = (Invoke-DuckDbJson "select * from metrics_loop_daily where event_date = '$targetDate' limit 1;")[0]
$latency = (Invoke-DuckDbJson "select * from metrics_latency_daily where event_date = '$targetDate' limit 1;")[0]
$compression = (Invoke-DuckDbJson "select * from metrics_compression_daily where event_date = '$targetDate' limit 1;")[0]
$toolMetrics = (Invoke-DuckDbJson "select * from metrics_tools_daily where event_date = '$targetDate' limit 1;")[0]
$recovery = (Invoke-DuckDbJson "select * from metrics_recovery_daily where event_date = '$targetDate' limit 1;")[0]
$flags = (Invoke-DuckDbJson "select * from system_flags where event_date = '$targetDate' limit 1;")[0]
$costShare = Invoke-DuckDbJson "select query_source, total_prompt_input_tokens, total_billed_tokens, daily_cost_share from query_source_cost_share_daily where event_date = '$targetDate' order by total_billed_tokens desc, query_source asc;"
$agentCosts = Invoke-DuckDbJson "select agent_name, source_group, agent_total_prompt_input_tokens, agent_total_billed_tokens, agent_cost_share, agent_query_count, agent_avg_turns_per_query, agent_avg_loop_iter_end from agent_cost_daily where event_date = '$targetDate' order by agent_total_billed_tokens desc, agent_name asc;"
$recentActions = Invoke-DuckDbJson "select user_action_id, duration_ms, query_count, main_thread_query_count, subagent_count, total_prompt_input_tokens, total_billed_tokens from user_actions where event_date = '$targetDate' order by started_at desc limit 10;"
$subagentReasons = Invoke-DuckDbJson "select subagent_reason, agent_name, subagent_count, avg_duration_ms from subagent_reason_daily where event_date = '$targetDate' order by subagent_count desc, subagent_reason asc;"
$queries = Invoke-DuckDbJson "select query_source, count(*) as query_count, sum(duration_ms) as total_duration_ms, sum(tool_call_count) as total_tool_calls from queries where started_at like '$targetDate%' group by 1 order by query_count desc, query_source asc;"
$tools = Invoke-DuckDbJson "select tool_name, tool_calls, tool_success_rate, tool_avg_duration_ms, tool_p95_duration_ms from tool_calls_by_name order by tool_calls desc, tool_name asc;"
$toolModes = Invoke-DuckDbJson "select tool_mode, tool_calls from tool_calls_by_mode order by tool_calls desc, tool_mode asc;"
$subagents = Invoke-DuckDbJson "select coalesce(subagent_type, 'unknown') as subagent_type, count(*) as subagent_count, avg(duration_ms) as avg_duration_ms from subagents where coalesce(spawned_at, completed_at, '') like '$targetDate%' group by 1 order by subagent_count desc, subagent_type asc;"

if (-not $rollup) {
  throw "No daily rollup found for $targetDate"
}

Write-Output "日期: $($rollup.event_date)"
Write-Output "源文件: $($buildMeta.source_events_file_name)"
Write-Output "源文件大小(bytes): $($buildMeta.source_events_size_bytes)"
Write-Output "建库时间: $($buildMeta.built_at)"
Write-Output "入库事件数: $($buildMeta.events_row_count)"
Write-Output ""
Write-Output "概览:"
Write-Output "  事件数: $($rollup.event_count)"
Write-Output "  用户动作数: $($rollup.user_action_count)"
Write-Output "  Query 数: $($rollup.query_count)"
Write-Output "  Turn 数: $($rollup.turn_count)"
Write-Output "  工具调用数: $($rollup.tool_call_count)"
Write-Output "  Subagent 数: $($rollup.subagent_count)"
Write-Output "  Snapshot 引用数: $($rollup.snapshot_ref_count)"
Write-Output "  最新事件时间: $($rollup.latest_event_ts)"
Write-Output ""
Write-Output "完整性:"
Write-Output "  user_action -> 主线程 query 覆盖率: $($integrity.user_action_main_query_coverage_rate)"
Write-Output "  原生 query 完成率: $($integrity.strict_query_completion_rate)"
Write-Output "  推断 query 完成率: $($integrity.inferred_query_completion_rate)"
Write-Output "  query 补链差值: $($integrity.query_completeness_gap)"
Write-Output "  原生 turn 闭合率: $($integrity.strict_turn_state_closure_rate)"
Write-Output "  推断 turn 闭合率: $($integrity.inferred_turn_state_closure_rate)"
Write-Output "  turn 补链差值: $($integrity.turn_closure_gap)"
Write-Output "  工具生命周期闭合率: $($integrity.tool_lifecycle_closure_rate)"
Write-Output "  subagent 生命周期闭合率: $($integrity.subagent_lifecycle_closure_rate)"
Write-Output "  snapshot 缺失率: $($integrity.snapshot_missing_rate)"
Write-Output "  orphan event 率: $($integrity.orphan_event_rate)"
Write-Output ""
Write-Output "成本 - 每日总量:"
Write-Output "  总 prompt 输入 tokens: $($cost.user_action_total_prompt_input_tokens)"
Write-Output "  总 billed tokens: $($cost.user_action_total_billed_tokens)"
Write-Output "  output tokens: $($cost.user_action_total_output_tokens)"
Write-Output "成本 - 结构拆分:"
Write-Output "  裸 input tokens: $($cost.user_action_total_raw_input_tokens)"
Write-Output "  cache read input tokens: $($cost.user_action_total_cache_read_tokens)"
Write-Output "  cache create input tokens: $($cost.user_action_total_cache_create_tokens)"
Write-Output "成本 - 主/子链路:"
Write-Output "  主线程总 prompt 输入 tokens: $($cost.main_thread_total_prompt_input_tokens)"
Write-Output "  subagent 总 prompt 输入 tokens: $($cost.subagent_total_prompt_input_tokens)"
Write-Output "  subagent 放大倍率: $($cost.subagent_amplification_ratio)"
Write-Output "成本 - 平均/效率:"
Write-Output "  平均每个 user_action 的 prompt 输入: $($cost.avg_total_prompt_input_tokens_per_user_action)"
Write-Output "  平均每个 user_action 的 billed: $($cost.avg_total_billed_tokens_per_user_action)"
Write-Output "  平均每个 query 的 prompt 输入: $($cost.avg_total_prompt_input_tokens_per_query)"
Write-Output "  平均每个 query 的 billed: $($cost.avg_total_billed_tokens_per_query)"
Write-Output "  每个成功 completed query 的平均成本: $($cost.cost_per_successful_completed_query)"
Write-Output ""
Write-Output "Loop / Turn:"
Write-Output "  每个 query 的平均 turn 数: $($loops.daily_avg_turns_per_query)"
Write-Output "  每个 query 的平均 loop 终点: $($loops.daily_avg_loop_iter_end)"
Write-Output "  query loop 终点 P95: $($loops.daily_p95_loop_iter_end)"
Write-Output "  loop_iter > 1 的 query 占比: $($loops.daily_queries_with_loop_iter_gt_1_rate)"
Write-Output ""
Write-Output "延迟(ms):"
Write-Output "  submit -> first chunk: $($latency.submit_to_first_chunk_ms)"
Write-Output "  preprocess: $($latency.preprocess_duration_ms)"
Write-Output "  prompt.build: $($latency.prompt_build_duration_ms)"
Write-Output "  request -> first chunk: $($latency.api_first_chunk_latency_ms)"
Write-Output "  request 总时长: $($latency.api_total_duration_ms)"
Write-Output "  工具执行平均时长: $($latency.tool_execution_duration_ms)"
Write-Output "  stop hooks 平均时长: $($latency.stop_hook_duration_ms)"
Write-Output "  subagent 生命周期平均时长: $($latency.subagent_duration_ms)"
Write-Output "  user action 端到端平均时长: $($latency.user_action_e2e_duration_ms)"
Write-Output ""
Write-Output "压缩与上下文治理:"
Write-Output "  preprocess 前 tokens 总量: $($compression.preprocess_tokens_before_total)"
Write-Output "  preprocess 后 tokens 总量: $($compression.preprocess_tokens_after_total)"
Write-Output "  总节省 tokens: $($compression.tokens_saved_total)"
Write-Output "  compression_gain_ratio: $($compression.compression_gain_ratio)"
Write-Output "  tool_result_budget_saved_tokens: $($compression.tool_result_budget_saved_tokens)"
Write-Output "  history_snip_saved_tokens: $($compression.history_snip_saved_tokens)"
Write-Output "  microcompact_saved_tokens: $($compression.microcompact_saved_tokens)"
Write-Output "  autocompact_saved_tokens: $($compression.autocompact_saved_tokens)"
Write-Output "  autocompact_trigger_rate: $($compression.autocompact_trigger_rate)"
Write-Output ""
Write-Output "工具:"
Write-Output "  工具调用总数: $($toolMetrics.tool_calls_total)"
Write-Output "  工具成功率: $($toolMetrics.tool_success_rate)"
Write-Output "  工具失败率: $($toolMetrics.tool_failure_rate)"
Write-Output "  工具平均时长: $($toolMetrics.tool_avg_duration_ms)"
Write-Output "  工具 P95 时长: $($toolMetrics.tool_p95_duration_ms)"
Write-Output "  context_update_rate: $($toolMetrics.context_update_rate)"
Write-Output "  tools_per_query: $($toolMetrics.tools_per_query)"
Write-Output "  tools_per_subagent: $($toolMetrics.tools_per_subagent)"
Write-Output "  tool_followup_turn_ratio: $($toolMetrics.tool_followup_turn_ratio)"
Write-Output ""
Write-Output "恢复与异常:"
Write-Output "  prompt_too_long_recovery_attempts: $($recovery.prompt_too_long_recovery_attempts)"
Write-Output "  prompt_too_long_recovery_success_rate: $($recovery.prompt_too_long_recovery_success_rate)"
Write-Output "  max_output_tokens_recovery_attempts: $($recovery.max_output_tokens_recovery_attempts)"
Write-Output "  max_output_tokens_recovery_success_rate: $($recovery.max_output_tokens_recovery_success_rate)"
Write-Output "  token_budget_continue_rate: $($recovery.token_budget_continue_rate)"
Write-Output "  stop_hook_block_rate: $($recovery.stop_hook_block_rate)"
Write-Output "  api_error_rate: $($recovery.api_error_rate)"
Write-Output "  tool_failure_terminal_rate: $($recovery.tool_failure_terminal_rate)"
Write-Output "  exporter_failure_rate: $($recovery.exporter_failure_rate)"
Write-Output "  dropped_event_rate: $($recovery.dropped_event_rate)"
Write-Output ""
Write-Output "显式状态:"
Write-Output "  contextCollapse_enabled_gauge: $($flags.contextCollapse_enabled_gauge)"
Write-Output "  contextCollapse_attempted: $($flags.contextCollapse_attempted)"
Write-Output "  contextCollapse_committed: $($flags.contextCollapse_committed)"
Write-Output "  history_snip_gate_state: $($flags.history_snip_gate_state)"
Write-Output "  history_snip_gate_on_rate: $($flags.history_snip_gate_on_rate)"
Write-Output ""
Write-Output "按 source 成本拆分:"
foreach ($row in @($costShare)) {
  Write-Output ("  {0}: total_prompt_input_tokens={1}, total_billed_tokens={2}, daily_cost_share={3}" -f $row.query_source, $row.total_prompt_input_tokens, $row.total_billed_tokens, $row.daily_cost_share)
}
Write-Output ""
Write-Output "按 agent/source 成本拆分:"
foreach ($row in @($agentCosts)) {
  Write-Output ("  {0} [{1}]: total_prompt_input_tokens={2}, total_billed_tokens={3}, cost_share={4}, queries={5}, avg_turns_per_query={6}, avg_loop_iter_end={7}" -f $row.agent_name, $row.source_group, $row.agent_total_prompt_input_tokens, $row.agent_total_billed_tokens, $row.agent_cost_share, $row.agent_query_count, $row.agent_avg_turns_per_query, $row.agent_avg_loop_iter_end)
}
Write-Output ""
Write-Output "按 source query 概览:"
foreach ($row in @($queries)) {
  Write-Output ("  {0}: queries={1}, total_duration_ms={2}, tool_calls={3}" -f $row.query_source, $row.query_count, $row.total_duration_ms, $row.total_tool_calls)
}
Write-Output ""
Write-Output "最近用户动作:"
foreach ($row in @($recentActions)) {
  Write-Output ("  {0}: duration_ms={1}, queries={2}, main_thread_queries={3}, subagents={4}, total_prompt_input_tokens={5}, total_billed_tokens={6}" -f $row.user_action_id, $row.duration_ms, $row.query_count, $row.main_thread_query_count, $row.subagent_count, $row.total_prompt_input_tokens, $row.total_billed_tokens)
}
Write-Output ""
Write-Output "工具明细:"
foreach ($row in @($tools)) {
  Write-Output ("  {0}: calls={1}, success_rate={2}, avg_duration_ms={3}, p95_duration_ms={4}" -f $row.tool_name, $row.tool_calls, $row.tool_success_rate, $row.tool_avg_duration_ms, $row.tool_p95_duration_ms)
}
Write-Output ""
Write-Output "工具模式:"
foreach ($row in @($toolModes)) {
  Write-Output ("  {0}: calls={1}" -f $row.tool_mode, $row.tool_calls)
}
Write-Output ""
Write-Output "Subagent 明细:"
foreach ($row in @($subagents)) {
  $avgDuration = if ($null -eq $row.avg_duration_ms) { 0 } else { [double]$row.avg_duration_ms }
  Write-Output ("  {0}: count={1}, avg_duration_ms={2}" -f $row.subagent_type, $row.subagent_count, [math]::Round($avgDuration, 2))
}
Write-Output ""
Write-Output "Subagent Reason 明细:"
foreach ($row in @($subagentReasons)) {
  $avgDuration = if ($null -eq $row.avg_duration_ms) { 0 } else { [double]$row.avg_duration_ms }
  Write-Output ("  {0} -> {1}: count={2}, avg_duration_ms={3}" -f $row.subagent_reason, $row.agent_name, $row.subagent_count, [math]::Round($avgDuration, 2))
}
