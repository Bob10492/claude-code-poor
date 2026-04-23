# DuckDB Schema 文档

数据库位置：
- `E:\claude-code\.observability\observability_v1.duckdb`

重建入口：
- `powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\rebuild_observability_db.ps1`

当前基础表与核心视图如下。

## `events_raw`

用途：
- 保存原始事件的一行一条结构化记录
- 补充 `effective_query_id`，用于修正少数 `query_id = null` 但可按时序和 `query_source` 推断归属的事件

关键字段：
- `event_idx`
- `ts_wall`
- `ts_wall_ms`
- `event_name`
- `user_action_id`
- `query_id`
- `effective_query_id`
- `turn_id`
- `subagent_id`
- `tool_call_id`
- `payload_json`
- `snapshot_refs_json`
- `raw_event_json`

## `queries`

用途：
- 按 `query_id` 聚合主线程 query 与 subagent query

关键字段：
- `query_id`
- `user_action_id`
- `query_source`
- `agent_name`
- `source_group`
- `subagent_id`
- `subagent_type`
- `subagent_reason`
- `started_at`
- `ended_at`
- `duration_ms`
- `terminal_reason`
- `stop_reason`
- `turn_count`
- `tool_call_count`
- `event_count`

## `turns`

用途：
- 按 `effective_query_id + turn_id` 聚合 turn
- 当前数据里 `turn_id` 不是全局唯一，所以使用 `turn_key`

关键字段：
- `turn_key`
- `query_id`
- `turn_id`
- `user_action_id`
- `subagent_id`
- `query_source`
- `loop_iter_start`
- `loop_iter_end`
- `duration_ms`
- `transition_out`
- `termination_reason`
- `stop_reason`
- `tool_call_count`

## `tools`

用途：
- 按 `tool_call_id` 聚合工具调用生命周期

关键字段：
- `tool_call_id`
- `user_action_id`
- `query_id`
- `subagent_id`
- `tool_name`
- `enqueued_at`
- `started_at`
- `completed_at`
- `duration_ms`
- `success`
- `failure_reason`

## `subagents`

用途：
- 按 `subagent_id` 聚合 forked agent 生命周期

关键字段：
- `subagent_id`
- `query_id`
- `user_action_id`
- `subagent_type`
- `subagent_reason`
- `query_source`
- `agent_name`
- `source_group`
- `spawned_at`
- `completed_at`
- `duration_ms`
- `transcript_enabled`
- `message_event_count`
- `completed`

## `recoveries`

用途：
- 收集恢复链、stop hooks、非 `next_turn` 的状态跳转

当前纳入：
- `stop_hooks.started`
- `stop_hooks.completed`
- `state.transitioned` 且 `to_transition != 'next_turn'`
- 名称中包含 `recovery` 的事件

关键字段：
- `recovery_key`
- `event_name`
- `user_action_id`
- `query_id`
- `turn_id`
- `subagent_id`
- `transition_to`
- `reason`
- `payload_json`

## `snapshots_index`

用途：
- 索引当前保留快照文件，并记录引用次数、hash、大小、类别

关键字段：
- `snapshot_ref`
- `file_name`
- `relative_path`
- `absolute_path`
- `exists`
- `size_bytes`
- `sha256`
- `referenced_count`
- `first_event_ts`
- `last_event_ts`
- `category`

## `daily_rollups`

用途：
- 提供按天的快速概览，供 summary CLI 和 dashboard 使用

关键字段：
- `event_date`
- `event_count`
- `user_action_count`
- `query_count`
- `turn_count`
- `tool_call_count`
- `subagent_count`
- `snapshot_ref_count`
- `latest_event_ts`

说明：
- `daily_rollups` 是按当前目标事件文件生成的日级摘要，不应写死某一天
- 当前到底是哪一天、多少条 query，应以 `daily_summary.ps1` 或库内实时查询结果为准

## 指标视图

当前还新增了以下 DuckDB 视图，供 CLI、dashboard、链路阅读器复用：

- `user_actions`
- `usage_facts`
- `agent_cost_daily`
- `query_source_cost_share`
- `query_source_cost_share_daily`
- `subagent_reason_daily`
- `metrics_integrity_daily`
- `metrics_cost_daily`
- `metrics_latency_daily`
- `metrics_loop_daily`
- `metrics_compression_daily`
- `metrics_tools_daily`
- `metrics_recovery_daily`
- `tool_calls_by_name`
- `tool_calls_by_mode`
- `terminal_reason_distribution`
- `system_flags`

## 脚本入口

- 重建库：`powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\rebuild_observability_db.ps1`
- 每日 summary：`powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\daily_summary.ps1`
- 链路阅读器：`powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\read_timeline.ps1 -UserActionId <id>`
- 单次动作解释器：`powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\explain_action.ps1 -UserActionId <id>`
- 生成 dashboard：`powershell -ExecutionPolicy Bypass -File E:\claude-code\scripts\observability\build_dashboard.ps1`
