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
$outputPath = Join-Path $repoRoot "ObservrityTask\observability_dashboard.html"

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

function Get-CellText {
  param(
    [object]$Value
  )

  if ($null -eq $Value) {
    return "null"
  }

  if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
    return ([math]::Round([double]$Value, 6)).ToString()
  }

  return [string]$Value
}

function New-MetricMeta {
  param(
    [string]$Label,
    [string]$Meaning,
    [string]$Example
  )

  return [PSCustomObject]@{
    label = $Label
    meaning = $Meaning
    example = $Example
  }
}

function ConvertTo-CardHtml {
  param(
    [string]$MetricKey,
    [string]$Label,
    [object]$Value
  )

  $safeLabel = [System.Net.WebUtility]::HtmlEncode($Label)
  $safeValue = [System.Net.WebUtility]::HtmlEncode((Get-CellText $Value))
  $safeKey = [System.Net.WebUtility]::HtmlEncode($MetricKey)

  return @"
<article class="card">
  <div class="card-top">
    <div class="card-label">$safeLabel</div>
    <a class="metric-link" href="#metric-$safeKey">说明</a>
  </div>
  <div class="card-value">$safeValue</div>
</article>
"@
}

function ConvertTo-TableHtml {
  param(
    [string]$Title,
    [object[]]$Rows
  )

  $safeTitle = [System.Net.WebUtility]::HtmlEncode($Title)
  if (-not $Rows -or $Rows.Count -eq 0) {
    return "<section class='panel'><h3>$safeTitle</h3><p class='muted'>没有数据。</p></section>"
  }

  $columns = @($Rows[0].PSObject.Properties.Name)
  $thead = ($columns | ForEach-Object { "<th>$([System.Net.WebUtility]::HtmlEncode($_))</th>" }) -join ""
  $tbody = foreach ($row in $Rows) {
    $cells = foreach ($column in $columns) {
      $value = Get-CellText $row.$column
      "<td>$([System.Net.WebUtility]::HtmlEncode($value))</td>"
    }
    "<tr>$($cells -join '')</tr>"
  }

  return @"
<section class="panel">
  <h3>$safeTitle</h3>
  <div class="table-wrap">
    <table>
      <thead><tr>$thead</tr></thead>
      <tbody>
        $($tbody -join "`n")
      </tbody>
    </table>
  </div>
</section>
"@
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
$queriesBySource = Invoke-DuckDbJson "select query_source, count(*) as query_count, sum(duration_ms) as total_duration_ms, sum(tool_call_count) as total_tool_calls from queries where started_at like '$targetDate%' group by 1 order by query_count desc, query_source asc;"
$toolByName = Invoke-DuckDbJson "select tool_name, tool_calls, tool_success_rate, tool_failure_rate, tool_avg_duration_ms, tool_p95_duration_ms from tool_calls_by_name order by tool_calls desc, tool_name asc;"
$toolByMode = Invoke-DuckDbJson "select tool_mode, tool_calls from tool_calls_by_mode order by tool_calls desc, tool_mode asc;"
$terminalReasons = Invoke-DuckDbJson "select terminal_reason, query_count from terminal_reason_distribution where event_date = '$targetDate' order by query_count desc, terminal_reason asc;"

$metricDocs = [ordered]@{
  event_count = (New-MetricMeta "事件数" "当天成功入库的结构化事件总数。" "例：375 代表这批样本里被 ETL 吃进去的事件一共有 375 条。")
  user_action_count = (New-MetricMeta "用户动作数" "能被同一个 user_action_id 串起来的用户动作数量。" "例：2 代表今天样本中有 2 次独立用户动作。")
  query_count = (New-MetricMeta "Query 数" "当天成功识别出来的 query 生命周期实体数量。" "例：6 代表这批样本里一共识别出 6 个 query。")
  turn_count = (New-MetricMeta "Turn 数" "当天成功识别出来的 turn 数量。" "例：12 说明 query 们一共走了 12 轮 turn。")
  tool_calls_total = (New-MetricMeta "工具调用数" "当天工具调用总数。" "例：9 说明主线程和 subagent 合计触发了 9 次工具调用。")
  subagent_count = (New-MetricMeta "Subagent 数" "当天成功识别到的 subagent 生命周期数量。" "例：4 说明共有 4 次子代理任务被创建。")
  strict_query_completion_rate = (New-MetricMeta "严格 Query 完成率" "只按原始 query_id 检查，同一个 query_id 是否同时出现 query.started 和 query.terminated。" "例：如果 terminated 丢了原始 query_id，这个值会偏低。")
  inferred_query_completion_rate = (New-MetricMeta "推断 Query 完成率" "允许使用 effective_query_id 补链后的 query 闭合率。" "例：它告诉你‘分析层是否还能把链串起来’，通常会高于严格口径。")
  query_completeness_gap = (New-MetricMeta "Query 补链差值" "推断 Query 完成率减去原生 Query 完成率。" "例：0.3 代表 ETL 补链帮你多恢复了 30% 的 query 闭合。")
  strict_turn_state_closure_rate = (New-MetricMeta "严格 Turn 闭合率" "只按原始 query_id + turn_id 检查 turn.started / before_turn / after_turn 三件套是否齐全。" "例：最后一轮缺 after_turn 时，这个值就会下降。")
  inferred_turn_state_closure_rate = (New-MetricMeta "推断 Turn 闭合率" "允许用 effective_query_id 做补链后的 turn 闭合率。" "例：它反映 ETL 是否还能拼出 turn 生命周期。")
  turn_closure_gap = (New-MetricMeta "Turn 补链差值" "推断 Turn 闭合率减去原生 Turn 闭合率。" "例：值越大，说明缺 query_id/turn_id 的事件越多。")
  tool_lifecycle_closure_rate = (New-MetricMeta "工具闭合率" "工具调用中，从 started 走到 completed 或 failed 的比例。" "例：1.0 代表工具调用生命周期全部闭合。")
  subagent_lifecycle_closure_rate = (New-MetricMeta "Subagent 闭合率" "subagent 同时出现 spawned 和 completed 的比例。" "例：1.0 代表子代理生命周期全部闭合。")
  snapshot_missing_rate = (New-MetricMeta "Snapshot 缺失率" "事件引用了 snapshot_ref，但本地找不到对应快照文件的比例。" "例：0 代表这批样本没有缺快照。")
  orphan_event_rate = (New-MetricMeta "Orphan Event 率" "无法挂靠到 user_action / query / turn / tool / subagent 的孤儿事件比例。" "例：值高时说明基础埋点键缺失严重。")
  raw_input_tokens = (New-MetricMeta "裸 Input Tokens" "模型 usage 里的 input_tokens 原值，不包含 cache read 和 cache create。" "例：你看到它只有 153，并不代表这次输入很小，只代表“新送进模型、未命中缓存的那一部分”只有 153。")
  cache_read_tokens = (New-MetricMeta "Cache Read Tokens" "本轮请求从 prompt cache 直接复用的输入 tokens。" "例：如果一个很长的 system prompt 被缓存复用，这里会很大，而裸 input 仍可能很小。")
  cache_create_tokens = (New-MetricMeta "Cache Create Tokens" "本轮请求为了创建或刷新 prompt cache 而计入的输入 tokens。" "例：第一次跑一段长 prompt 时，这里可能会突然升高。")
  total_prompt_input_tokens = (New-MetricMeta "总 Prompt 输入 Tokens" "真正建议优先看的输入成本。= 裸 input + cache read + cache create。" "例：裸 input 153、cache read 245210、cache create 219661，则总 prompt 输入是 465024。")
  output_tokens = (New-MetricMeta "Output Tokens" "模型输出的 tokens 总量。" "例：如果 output 只有 3027，而总 prompt 输入是 46.5 万，说明成本瓶颈主要在输入侧。")
  total_billed_tokens = (New-MetricMeta "总 Billed Tokens" "总 prompt 输入 tokens 再加 output tokens 后形成的总账单口径。" "例：465024 + 3027 = 468051。")
  main_thread_prompt_tokens = (New-MetricMeta "主线程 Prompt 输入" "只统计 `repl_main_thread` 的总 prompt 输入 tokens。" "例：它能让你看清主线程本身有多贵。")
  subagent_prompt_tokens = (New-MetricMeta "Subagent Prompt 输入" "只统计非 `repl_main_thread` 的总 prompt 输入 tokens。" "例：如果它远高于主线程，说明 memory / side query 链路在放大成本。")
  subagent_amplification_ratio = (New-MetricMeta "Subagent 放大倍率" "subagent 总 prompt 输入 tokens / 主线程总 prompt 输入 tokens。" "例：5.3 代表 memory / side query 等子链路把输入成本放大到了主线程的 5.3 倍。")
  avg_prompt_input_per_user_action = (New-MetricMeta "每个用户动作平均 Prompt 输入" "每天总 prompt 输入成本除以当天 user_action 数。" "例：它能快速回答‘平均一次用户动作要吃多少输入成本’。")
  avg_billed_per_user_action = (New-MetricMeta "每个用户动作平均 Billed" "每天总 billed tokens 除以当天 user_action 数。" "例：适合看整天的平均账单压力。")
  avg_prompt_input_per_query = (New-MetricMeta "每个 Query 平均 Prompt 输入" "每天所有 query 的平均总 prompt 输入成本。" "例：它能区分‘今天 query 变多’和‘单个 query 变贵’。")
  avg_billed_per_query = (New-MetricMeta "每个 Query 平均 Billed" "每天所有 query 的平均 billed tokens。" "例：如果这个值升高，说明单个 query 的综合成本变重了。")
  submit_to_first_chunk_ms = (New-MetricMeta "Submit 到 First Chunk" "一次用户动作从当前可闭合起点到主线程 first chunk 的平均时长。" "例：这个值高说明用户等到首字节的时间长。")
  preprocess_duration_ms = (New-MetricMeta "Preprocess 时长" "从预处理开始到 prompt.build.started 的平均时长。" "例：值高说明消息裁剪、压缩或上下文整理耗时较多。")
  prompt_build_duration_ms = (New-MetricMeta "Prompt.Build 时长" "从 prompt.build.started 到 prompt.build.completed 的平均时长。" "例：值高说明提示词拼装和序列化成本较高。")
  api_first_chunk_latency_ms = (New-MetricMeta "Request 到 First Chunk" "从 API 请求发起到首个流式 chunk 返回的平均时长。" "例：它主要反映模型首字延迟。")
  api_total_duration_ms = (New-MetricMeta "API 总时长" "单轮 request 从发起到流式完成的平均时长。" "例：如果它很高，再看工具/恢复链才能知道慢在哪里。")
  tool_execution_duration_ms = (New-MetricMeta "工具执行平均时长" "所有工具调用的平均执行时长。" "例：值高时通常要看慢工具明细。")
  stop_hook_duration_ms = (New-MetricMeta "Stop Hooks 平均时长" "stop hook 生命周期的平均时长。" "例：值高说明停止逻辑本身在拖慢响应。")
  subagent_duration_ms = (New-MetricMeta "Subagent 生命周期均值" "subagent 从 spawned 到 completed 的平均时长。" "例：值高通常意味着 memory 相关子链路比较慢。")
  user_action_e2e_duration_ms = (New-MetricMeta "User Action E2E" "一次用户动作从最早事件到最晚事件的端到端平均时长。" "例：这是用户真正感受到的总耗时。")
  daily_avg_turns_per_query = (New-MetricMeta "每日平均 Turn/Query" "按 query 统计的平均 turn 数。" "例：值高可能意味着更常见的多轮循环。")
  daily_avg_loop_iter_end = (New-MetricMeta "每日平均 Loop 终点" "每个 query 的最大 loop_iter 再求平均。" "例：它能区分‘prompt 大’和‘因为多轮 loop 导致成本高’。")
  daily_p95_loop_iter_end = (New-MetricMeta "每日 Loop 终点 P95" "query_max_loop_iter 的 P95。" "例：它比平均值更容易看出少数长链 loop。")
  daily_queries_with_loop_iter_gt_1_rate = (New-MetricMeta "多轮 Query 占比" "query_max_loop_iter > 1 的 query 占比。" "例：0.6 代表 60% 的 query 至少循环了 2 轮。")
  preprocess_tokens_before_total = (New-MetricMeta "Preprocess 前 Tokens" "进入上下文治理前的估算 token 总量。" "例：它是判断压缩压力的起点。")
  preprocess_tokens_after_total = (New-MetricMeta "Preprocess 后 Tokens" "经过上下文治理后的估算 token 总量。" "例：和前值对比可以看出压缩是否生效。")
  tokens_saved_total = (New-MetricMeta "总节省 Tokens" "预处理阶段累计节省的 tokens 总量。" "例：如果是 0，代表这批样本里压缩动作没有明显节省。")
  compression_gain_ratio = (New-MetricMeta "压缩收益率" "preprocess 前后 token 总量的节省比例。" "例：0.2 代表 preprocess 后上下文整体缩短了 20%。")
  autocompact_trigger_rate = (New-MetricMeta "Autocompact 触发率" "messages.autoconpact.completed 中 compacted = true 的比例。" "例：值高说明上下文压力大，经常需要自动压缩。")
  history_snip_gate_state = (New-MetricMeta "HISTORY_SNIP Gate 状态" "当前样本里是否观察到 HISTORY_SNIP 命中。" "例：‘样本中观察到命中’说明这批日志里 gate 至少生效过一次。")
  contextCollapse_enabled_gauge = (New-MetricMeta "contextCollapse 启用状态" "当前按源码真相给出。0 代表 disabled / stub，不应被解释成真实已启用。" "例：即使日志里有相关痕迹，这里仍必须显示 0。")
  tool_success_rate = (New-MetricMeta "工具成功率" "工具调用中 success = true 的比例。" "例：如果它下降，就该优先排查失败最多的工具。")
  tool_failure_rate = (New-MetricMeta "工具失败率" "工具调用中 failed 的比例。" "例：它和工具成功率一起决定工具层健康度。")
  tool_avg_duration_ms = (New-MetricMeta "工具平均时长" "按所有工具调用计算的平均执行时长。" "例：适合快速判断工具层是否整体变慢。")
  tool_p95_duration_ms = (New-MetricMeta "工具 P95 时长" "工具执行时长的 P95。" "例：它比平均值更容易暴露长尾慢调用。")
  tools_per_query = (New-MetricMeta "每个 Query 的工具数" "平均每个 query 触发多少次工具调用。" "例：值高说明 query 更依赖工具链。")
  tools_per_subagent = (New-MetricMeta "每个 Subagent 的工具数" "平均每个 subagent 触发多少次工具调用。" "例：它能看出子代理是否重度依赖工具。")
  tool_followup_turn_ratio = (New-MetricMeta "工具后续驱动率" "包含 tool_use 的 turn 中，最终 transition_out = next_turn 的比例。" "例：值高说明工具确实在驱动下一轮 loop。")
  prompt_too_long_recovery_attempts = (New-MetricMeta "Prompt Too Long 恢复次数" "恢复链里与 prompt_too_long 相关的尝试次数。" "例：如果这个值持续升高，说明 prompt 治理本身有问题。")
  max_output_tokens_recovery_attempts = (New-MetricMeta "Max Output Tokens 恢复次数" "恢复链里与 max_output_tokens 相关的尝试次数。" "例：值高说明输出上限策略经常撞线。")
  token_budget_continue_rate = (New-MetricMeta "Token Budget Continue Rate" "token_budget.decision 中 action = continue 的比例。" "例：值高说明系统经常需要续跑才能完成响应。")
  stop_hook_block_rate = (New-MetricMeta "Stop Hook Block Rate" "stop hook 最终阻止继续执行的比例。" "例：值高时说明停止逻辑频繁打断主链。")
  api_error_rate = (New-MetricMeta "API Error Rate" "API 调用阶段错误的比例。" "例：这个值非零时要优先检查模型请求和网络错误。")
  tool_failure_terminal_rate = (New-MetricMeta "Tool Failure Terminal Rate" "工具失败后直接导致 query 终止的比例。" "例：值高说明工具失败很难恢复。")
}

$overviewCards = @(
  (ConvertTo-CardHtml "event_count" "事件数" $rollup.event_count),
  (ConvertTo-CardHtml "user_action_count" "用户动作数" $rollup.user_action_count),
  (ConvertTo-CardHtml "query_count" "Query 数" $rollup.query_count),
  (ConvertTo-CardHtml "turn_count" "Turn 数" $rollup.turn_count),
  (ConvertTo-CardHtml "tool_calls_total" "工具调用数" $toolMetrics.tool_calls_total),
  (ConvertTo-CardHtml "subagent_count" "Subagent 数" $rollup.subagent_count)
) -join "`n"

$integrityCards = @(
  (ConvertTo-CardHtml "strict_query_completion_rate" "严格 Query 完成率" $integrity.strict_query_completion_rate),
  (ConvertTo-CardHtml "inferred_query_completion_rate" "推断 Query 完成率" $integrity.inferred_query_completion_rate),
  (ConvertTo-CardHtml "query_completeness_gap" "Query 补链差值" $integrity.query_completeness_gap),
  (ConvertTo-CardHtml "strict_turn_state_closure_rate" "严格 Turn 闭合率" $integrity.strict_turn_state_closure_rate),
  (ConvertTo-CardHtml "inferred_turn_state_closure_rate" "推断 Turn 闭合率" $integrity.inferred_turn_state_closure_rate),
  (ConvertTo-CardHtml "turn_closure_gap" "Turn 补链差值" $integrity.turn_closure_gap),
  (ConvertTo-CardHtml "tool_lifecycle_closure_rate" "工具闭合率" $integrity.tool_lifecycle_closure_rate),
  (ConvertTo-CardHtml "subagent_lifecycle_closure_rate" "Subagent 闭合率" $integrity.subagent_lifecycle_closure_rate),
  (ConvertTo-CardHtml "snapshot_missing_rate" "Snapshot 缺失率" $integrity.snapshot_missing_rate),
  (ConvertTo-CardHtml "orphan_event_rate" "Orphan Event 率" $integrity.orphan_event_rate)
) -join "`n"

$costDailyTotalCards = @(
  (ConvertTo-CardHtml "total_prompt_input_tokens" "总 Prompt 输入 Tokens" $cost.user_action_total_prompt_input_tokens),
  (ConvertTo-CardHtml "total_billed_tokens" "总 Billed Tokens" $cost.user_action_total_billed_tokens),
  (ConvertTo-CardHtml "output_tokens" "Output Tokens" $cost.user_action_total_output_tokens)
) -join "`n"

$costStructureCards = @(
  (ConvertTo-CardHtml "raw_input_tokens" "裸 Input Tokens" $cost.user_action_total_raw_input_tokens),
  (ConvertTo-CardHtml "cache_read_tokens" "Cache Read Tokens" $cost.user_action_total_cache_read_tokens),
  (ConvertTo-CardHtml "cache_create_tokens" "Cache Create Tokens" $cost.user_action_total_cache_create_tokens)
) -join "`n"

$costChainCards = @(
  (ConvertTo-CardHtml "main_thread_prompt_tokens" "主线程 Prompt 输入" $cost.main_thread_total_prompt_input_tokens),
  (ConvertTo-CardHtml "subagent_prompt_tokens" "Subagent Prompt 输入" $cost.subagent_total_prompt_input_tokens),
  (ConvertTo-CardHtml "subagent_amplification_ratio" "Subagent 放大倍率" $cost.subagent_amplification_ratio)
) -join "`n"

$costAverageCards = @(
  (ConvertTo-CardHtml "avg_prompt_input_per_user_action" "每个用户动作平均 Prompt 输入" $cost.avg_total_prompt_input_tokens_per_user_action),
  (ConvertTo-CardHtml "avg_billed_per_user_action" "每个用户动作平均 Billed" $cost.avg_total_billed_tokens_per_user_action),
  (ConvertTo-CardHtml "avg_prompt_input_per_query" "每个 Query 平均 Prompt 输入" $cost.avg_total_prompt_input_tokens_per_query),
  (ConvertTo-CardHtml "avg_billed_per_query" "每个 Query 平均 Billed" $cost.avg_total_billed_tokens_per_query)
) -join "`n"

$loopCards = @(
  (ConvertTo-CardHtml "daily_avg_turns_per_query" "每日平均 Turn/Query" $loops.daily_avg_turns_per_query),
  (ConvertTo-CardHtml "daily_avg_loop_iter_end" "每日平均 Loop 终点" $loops.daily_avg_loop_iter_end),
  (ConvertTo-CardHtml "daily_p95_loop_iter_end" "每日 Loop 终点 P95" $loops.daily_p95_loop_iter_end),
  (ConvertTo-CardHtml "daily_queries_with_loop_iter_gt_1_rate" "多轮 Query 占比" $loops.daily_queries_with_loop_iter_gt_1_rate)
) -join "`n"

$latencyCards = @(
  (ConvertTo-CardHtml "submit_to_first_chunk_ms" "Submit -> First Chunk" $latency.submit_to_first_chunk_ms),
  (ConvertTo-CardHtml "preprocess_duration_ms" "Preprocess" $latency.preprocess_duration_ms),
  (ConvertTo-CardHtml "prompt_build_duration_ms" "Prompt.Build" $latency.prompt_build_duration_ms),
  (ConvertTo-CardHtml "api_first_chunk_latency_ms" "Request -> First Chunk" $latency.api_first_chunk_latency_ms),
  (ConvertTo-CardHtml "api_total_duration_ms" "API 总时长" $latency.api_total_duration_ms),
  (ConvertTo-CardHtml "tool_execution_duration_ms" "工具执行平均时长" $latency.tool_execution_duration_ms),
  (ConvertTo-CardHtml "stop_hook_duration_ms" "Stop Hooks 平均时长" $latency.stop_hook_duration_ms),
  (ConvertTo-CardHtml "subagent_duration_ms" "Subagent 生命周期均值" $latency.subagent_duration_ms),
  (ConvertTo-CardHtml "user_action_e2e_duration_ms" "User Action E2E" $latency.user_action_e2e_duration_ms)
) -join "`n"

$compressionCards = @(
  (ConvertTo-CardHtml "preprocess_tokens_before_total" "Preprocess 前 Tokens" $compression.preprocess_tokens_before_total),
  (ConvertTo-CardHtml "preprocess_tokens_after_total" "Preprocess 后 Tokens" $compression.preprocess_tokens_after_total),
  (ConvertTo-CardHtml "tokens_saved_total" "总节省 Tokens" $compression.tokens_saved_total),
  (ConvertTo-CardHtml "compression_gain_ratio" "压缩收益率" $compression.compression_gain_ratio),
  (ConvertTo-CardHtml "autocompact_trigger_rate" "Autocompact 触发率" $compression.autocompact_trigger_rate),
  (ConvertTo-CardHtml "history_snip_gate_state" "HISTORY_SNIP Gate" $flags.history_snip_gate_state),
  (ConvertTo-CardHtml "contextCollapse_enabled_gauge" "contextCollapse 启用状态" $flags.contextCollapse_enabled_gauge)
) -join "`n"

$toolCards = @(
  (ConvertTo-CardHtml "tool_success_rate" "工具成功率" $toolMetrics.tool_success_rate),
  (ConvertTo-CardHtml "tool_failure_rate" "工具失败率" $toolMetrics.tool_failure_rate),
  (ConvertTo-CardHtml "tool_avg_duration_ms" "工具平均时长" $toolMetrics.tool_avg_duration_ms),
  (ConvertTo-CardHtml "tool_p95_duration_ms" "工具 P95 时长" $toolMetrics.tool_p95_duration_ms),
  (ConvertTo-CardHtml "tools_per_query" "每个 Query 的工具数" $toolMetrics.tools_per_query),
  (ConvertTo-CardHtml "tools_per_subagent" "每个 Subagent 的工具数" $toolMetrics.tools_per_subagent),
  (ConvertTo-CardHtml "tool_followup_turn_ratio" "工具后续驱动率" $toolMetrics.tool_followup_turn_ratio)
) -join "`n"

$recoveryCards = @(
  (ConvertTo-CardHtml "prompt_too_long_recovery_attempts" "Prompt Too Long 恢复次数" $recovery.prompt_too_long_recovery_attempts),
  (ConvertTo-CardHtml "max_output_tokens_recovery_attempts" "Max Output Tokens 恢复次数" $recovery.max_output_tokens_recovery_attempts),
  (ConvertTo-CardHtml "token_budget_continue_rate" "Token Budget Continue Rate" $recovery.token_budget_continue_rate),
  (ConvertTo-CardHtml "stop_hook_block_rate" "Stop Hook Block Rate" $recovery.stop_hook_block_rate),
  (ConvertTo-CardHtml "api_error_rate" "API Error Rate" $recovery.api_error_rate),
  (ConvertTo-CardHtml "tool_failure_terminal_rate" "Tool Failure Terminal Rate" $recovery.tool_failure_terminal_rate)
) -join "`n"

$glossarySections = foreach ($entry in $metricDocs.GetEnumerator()) {
  $key = [System.Net.WebUtility]::HtmlEncode($entry.Key)
  $label = [System.Net.WebUtility]::HtmlEncode($entry.Value.label)
  $meaning = [System.Net.WebUtility]::HtmlEncode($entry.Value.meaning)
  $example = [System.Net.WebUtility]::HtmlEncode($entry.Value.example)
  @"
<section class="metric-doc" id="metric-$key">
  <h3>$label</h3>
  <p><strong>含义：</strong>$meaning</p>
  <p><strong>举例：</strong>$example</p>
</section>
"@
}

$html = @"
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>本地可观测系统 V1 Dashboard</title>
  <style>
    :root {
      --bg: #f7f2e8;
      --panel: #fffaf0;
      --ink: #1f1b16;
      --muted: #726657;
      --line: #dfd1be;
      --accent: #b24c2d;
      --accent-soft: #f3d4c7;
      --shadow: rgba(86, 53, 24, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(243, 212, 199, 0.65), transparent 28%),
        linear-gradient(180deg, #fbf7f0 0%, #f4ede1 100%);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page {
      width: min(1380px, calc(100vw - 40px));
      margin: 24px auto 40px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 14px 40px var(--shadow);
    }
    .hero {
      padding: 28px;
      margin-bottom: 18px;
    }
    .hero h1 {
      margin: 0 0 12px;
      font-size: 34px;
      line-height: 1.1;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.7;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 20px;
    }
    .meta-chip {
      padding: 12px 14px;
      border-radius: 14px;
      background: #fff4e7;
      border: 1px solid var(--line);
    }
    .meta-chip .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .meta-chip .value {
      font-size: 15px;
      font-weight: 700;
      word-break: break-all;
    }
    .section {
      margin-bottom: 18px;
    }
    .section h2 {
      margin: 0 0 12px;
      font-size: 22px;
    }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .card {
      padding: 16px;
      border-radius: 16px;
      background: #fffdf8;
      border: 1px solid var(--line);
      min-height: 116px;
    }
    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
    }
    .card-label {
      font-size: 13px;
      color: var(--muted);
    }
    .card-value {
      font-size: 28px;
      font-weight: 800;
      line-height: 1.1;
      word-break: break-word;
    }
    .metric-link {
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      flex-shrink: 0;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      margin-bottom: 18px;
    }
    .panel {
      padding: 20px;
    }
    .panel h2, .panel h3 {
      margin-top: 0;
    }
    .muted {
      color: var(--muted);
      line-height: 1.7;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 700;
      background: #fff6ea;
    }
    .metric-docs {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .metric-doc {
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #fffdf8;
    }
    .metric-doc h3 {
      margin: 0 0 10px;
      font-size: 16px;
    }
    .metric-doc p {
      margin: 0 0 8px;
      color: var(--muted);
      line-height: 1.7;
    }
    @media (max-width: 980px) {
      .two-col {
        grid-template-columns: 1fr;
      }
      .page {
        width: min(100vw - 20px, 1380px);
        margin: 12px auto 24px;
      }
      .hero {
        padding: 20px;
      }
      .card-value {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <h1>本地可观测系统 V1</h1>
      <p>这版 dashboard 按方向 A 执行清单把指标分成更稳定的分析层级。成本侧按 <strong>每日总量</strong>、<strong>成本结构</strong>、<strong>主/子链路</strong>、<strong>日均/效率</strong> 展示；完整性侧同时提供 <strong>原生口径</strong>、<strong>推断口径</strong> 和 <strong>补链差值</strong>；loop 指标单独拆开，用来区分“prompt 大”还是“多轮循环导致贵”。</p>
      <div class="meta">
        <div class="meta-chip"><div class="label">日期</div><div class="value">$([System.Net.WebUtility]::HtmlEncode((Get-CellText $targetDate)))</div></div>
        <div class="meta-chip"><div class="label">源文件</div><div class="value">$([System.Net.WebUtility]::HtmlEncode((Get-CellText $buildMeta.source_events_file_name)))</div></div>
        <div class="meta-chip"><div class="label">文件大小(bytes)</div><div class="value">$([System.Net.WebUtility]::HtmlEncode((Get-CellText $buildMeta.source_events_size_bytes)))</div></div>
        <div class="meta-chip"><div class="label">建库时间</div><div class="value">$([System.Net.WebUtility]::HtmlEncode((Get-CellText $buildMeta.built_at)))</div></div>
      </div>
    </section>

    <section class="section">
      <h2>概览</h2>
      <div class="card-grid">
        $overviewCards
      </div>
    </section>

    <section class="section">
      <h2>完整性</h2>
      <div class="card-grid">
        $integrityCards
      </div>
    </section>

    <section class="section">
      <h2>成本 - 每日总量</h2>
      <div class="card-grid">
        $costDailyTotalCards
      </div>
    </section>

    <section class="section">
      <h2>成本 - 结构拆分</h2>
      <div class="card-grid">
        $costStructureCards
      </div>
    </section>

    <section class="section">
      <h2>成本 - 主/子链路</h2>
      <div class="card-grid">
        $costChainCards
      </div>
    </section>

    <section class="section">
      <h2>成本 - 日均/效率</h2>
      <div class="card-grid">
        $costAverageCards
      </div>
    </section>

    <section class="section">
      <h2>Loop / Turn</h2>
      <div class="card-grid">
        $loopCards
      </div>
    </section>

    <section class="section">
      <h2>延迟</h2>
      <div class="card-grid">
        $latencyCards
      </div>
    </section>

    <div class="two-col">
      <section class="panel">
        <h2>压缩与上下文治理</h2>
        <div class="card-grid">
          $compressionCards
        </div>
      </section>
      <section class="panel">
        <h2>工具与恢复</h2>
        <div class="card-grid">
          $toolCards
          $recoveryCards
        </div>
      </section>
    </div>

    $(ConvertTo-TableHtml "按 Source 成本拆分" $costShare)
    $(ConvertTo-TableHtml "按 Agent/Source 成本拆分" $agentCosts)
    $(ConvertTo-TableHtml "最近用户动作" $recentActions)
    $(ConvertTo-TableHtml "按 Source Query 概览" $queriesBySource)
    $(ConvertTo-TableHtml "Subagent Reason 明细" $subagentReasons)
    $(ConvertTo-TableHtml "工具按名称统计" $toolByName)
    $(ConvertTo-TableHtml "工具按模式统计" $toolByMode)
    $(ConvertTo-TableHtml "终止原因分布" $terminalReasons)

    <section class="panel">
      <h2>指标说明</h2>
      <p class="muted">每张卡片右上角的“说明”都会跳到这里。这里优先解释最容易误解、最容易影响判断的指标，尤其是 token 成本口径。</p>
      <div class="metric-docs">
        $($glossarySections -join "`n")
      </div>
    </section>
  </div>
</body>
</html>
"@

Set-Content -LiteralPath $outputPath -Value $html -Encoding UTF8
Write-Output $outputPath
