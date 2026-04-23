# 统一事件 Schema 文档

本文描述新增本地 harness observability 事件流的结构、命名、快照约定与阅读原则。

---

## 1. 目标

这套事件流不是替代现有 `logEvent(...)` analytics，而是旁路补充：

- 面向本地调试与链路还原
- 允许记录结构化摘要
- 通过 sidecar snapshot 记录大对象
- 可串联用户提交、query 多轮、tool、stop hooks、subagent

主文件位置：

```text
.observability/events-YYYYMMDD.jsonl
.observability/snapshots/*.json
```

实现入口：

```text
src/observability/harness.ts
```

---

## 2. 事件公共字段

每条事件至少包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 当前事件 schema 版本 |
| `ts_wall` | ISO8601 墙钟时间 |
| `ts_mono_ms` | 单调时钟毫秒，便于同进程时序分析 |
| `level` | `debug/info/warning/error` |
| `event` | 事件名，采用 `domain.action.stage` |
| `component` | 事件来源组件 |
| `session_id` | 当前 session |
| `conversation_id` | 当前会话链标识，默认与 `session_id` 同步 |
| `user_action_id` | 用户动作 ID，通常取输入消息 UUID |
| `query_id` | query 链 ID |
| `turn_id` | turn 标识，当前实现为 `turn-N` |
| `loop_iter` | loop 轮次 |
| `parent_turn_id` | 父 turn，当前预留 |
| `subagent_id` | 子 agent ID |
| `subagent_type` | 子 agent 类型或 fork label |
| `subagent_reason` | 子 agent 启动原因，优先由调用点显式传入 |
| `query_source` | query source |
| `request_id` | API request id |
| `tool_call_id` | 工具调用 id |
| `span_id` | 预留 |
| `parent_span_id` | 预留 |
| `cwd` | 当前工作目录 |
| `git_branch` | 预留 |
| `build_version` | 当前构建版本 |
| `payload` | 业务负载 |

---

## 3. 快照对象

大对象不直接塞进主事件，而是落 sidecar snapshot。

主事件引用格式：

```json
{
  "snapshot_ref": "./.observability/snapshots/xxx.json",
  "bytes": 12345,
  "sha256": "abcdef...",
  "redaction_state": "raw"
}
```

当前 `redaction_state` 枚举：

- `raw`
- `redacted`
- `unknown`

---

## 4. 命名规范

统一采用：

```text
domain.action.stage
```

示例：

- `submit.attempted`
- `input.process.completed`
- `messages.microcompact.applied`
- `prompt.build.completed`
- `api.request.started`
- `assistant.tool_use.detected`
- `tool.execution.completed`
- `stop_hooks.completed`
- `subagent.completed`
- `state.transitioned`
- `query.terminated`

---

## 5. 当前已实现事件

### 5.1 提交与输入

- `submit.attempted`
- `submit.blocked`
- `input.process.started`
- `input.process.completed`
- `file_history.snapshot.created`

### 5.2 query / state 初始化

- `query.started`
- `state.initialized`
- `prefetch.memory.started`
- `turn.started`
- `query_tracking.assigned`

### 5.3 messages 预处理链

- `messages.compact_boundary.applied`
- `messages.tool_result_budget.applied`
- `messages.history_snip.applied`
- `messages.microcompact.applied`
- `messages.context_collapse.applied`
- `messages.autoconpact.checked`
- `messages.autoconpact.completed`
- `messages.preprocess.completed`

### 5.4 prompt / API / streaming

- `prompt.build.started`
- `prompt.build.completed`
- `prompt.snapshot.stored`
- `api.request.started`
- `api.stream.first_chunk`
- `assistant.block.received`
- `assistant.tool_use.detected`
- `api.stream.completed`

### 5.5 tool

- `tool.execution.mode.selected`
- `tool.batch.started`
- `tool.enqueued`
- `tool.execution.started`
- `tool.execution.completed`
- `tool.execution.failed`
- `tool.context.updated`

### 5.6 stop hooks

- `stop_hooks.started`
- `stop_hooks.completed`

### 5.7 state / token budget / query terminate

- `state.snapshot.before_turn`
- `state.snapshot.after_turn`
- `state.transitioned`
- `token_budget.decision`
- `query.terminated`

### 5.8 subagent

- `subagent.spawn.requested`
- `subagent.spawned`
- `subagent.message.received`
- `subagent.completed`

---

## 6. 关键 payload 约定

### `messages.*`

统一记录：

- `messages_before`
- `messages_after`
- `message_types_before`
- `message_types_after`
- `estimated_tokens_before`
- `estimated_tokens_after`
- `tokens_saved`
- `attachments_before`
- `attachments_after`
- `tool_results_before`
- `tool_results_after`
- `snapshot_before_ref`
- `snapshot_after_ref`

### `prompt.build.completed`

当前已记录：

- `provider`
- `query_source`
- `model`
- `system_prompt_segments_count`
- `system_prompt_chars`
- `tool_names_count`
- `tool_names_chars`
- `messages_chars_total`
- `attachments_chars_total`
- `serialized_request_bytes`
- `request_snapshot_ref`

### `tool.execution.*`

当前已记录：

- `tool_name`
- `success`
- `duration_ms`
- `input_keys`
- `tool_call_id`

### `state.transitioned`

当前已记录：

- `from_transition`
- `to_transition`
- `from_messages_count`
- `to_messages_count`
- `message_delta`
- `token_estimate_before`
- `token_estimate_after`
- `before_snapshot_ref`
- `after_snapshot_ref`

### `query.terminated`

当前已记录：

- `reason`
- `final_message_count`
- `transition`

终态约定：

- 对正常 `end_turn -> query.terminated` 的收尾分支，当前实现会在终止前补发一次 `state.snapshot.after_turn`
- ETL 同时兼容旧日志；即使旧样本缺少这条终态 `after_turn`，也会把“`end_turn + query.terminated`”识别为闭合终态 turn

---

## 7. 当前未完全覆盖项

以下仍在推进中：

- `api.fallback.triggered`
- `api.error.withheld`
- `tool.progress`
- `tool.result.normalized`
- `recovery.prompt_too_long.*`
- `recovery.max_output_tokens.*`
- `subagent.prompt.build.completed`
- `subagent.tool.summary`

---

## 8. 兼容原则

- 默认行为不因埋点改变
- 事件写本地文件，旁路现有 analytics
- 允许未来补更多字段，但尽量不破坏现有命名
- 快照只做证据存储，主事件保留摘要
- `user_action_id` 是整次用户动作的根键；阅读完整执行树时，应优先用它串主线程与所有 subagent

---

## 9. 阅读原则

先看主事件，再看快照：

1. 用 `query_id` 串主链
2. 用 `tool_call_id` 串工具
3. 用 `subagent_id` 串子线程
4. 用 `snapshot_ref` 回看完整对象
