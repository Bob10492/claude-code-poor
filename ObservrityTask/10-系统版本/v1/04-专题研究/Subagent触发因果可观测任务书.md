# Subagent 触发因果可观测任务书

本文定义可观测系统下一阶段建设任务：为 forked subagent 增加“触发因果”层观测，补齐当前系统只能回答“开了什么”，但不能稳定回答“为什么此刻开”的缺口。

---

## 0. 理解清单

- 当前系统已经能看到：
  - 开了哪些 subagent
  - 每条 subagent 跑了多久、花了多少 token、是否闭合
- 当前系统还看不到：
  - 为什么是这一刻启动这条 subagent
  - 是 hook、阈值、命令、定时器，还是 compact 流程触发
- 本任务不是替换现有字段，而是补一层新的“触发因果字段”
- 新增字段的核心目标是把三层语义拆开：
  - `subagent_reason`：它为什么存在
  - `subagent_trigger_kind`：它通过什么机制被触发
  - `subagent_trigger_detail`：它具体走了哪条判定分支
- 第一批最关键的对象是：
  - `session_memory`
  - `extract_memories`
  - `side_question`
  - 其次再覆盖 `prompt_suggestion / compact / auto_dream / agent_summary / speculation`

---

## 1. 背景

当前系统已经能够稳定观测：

- `user_action_id`
- `query_id`
- `subagent_id`
- `query_source`
- `subagent_type`
- `subagent_reason`

因此已经可以回答：

- 开了哪些 subagent
- 每条 subagent 跑了多少 turn
- 花了多少 token
- 最终是否闭合

但当前系统仍不能稳定回答：

- 为什么是这一类 subagent
- 为什么在这一时刻启动
- 是 hook、阈值、显式命令、定时器，还是 compact 流程触发
- 同一类 subagent 的不同启动分支分别占多少

这导致：

- action 报告只能描述“这里发生了分叉”，但很难说明“这里为什么分叉”
- dashboard 只能按 `source / reason` 看成本，不能按触发机制看成本
- 后续 V2/V3 若引入更多 forked agent，现有字段会越来越不够用

---

## 1.1 预期效果

本任务完成后，系统不再只能说：

- “这里启动了一条 `session_memory`”

而应能说：

- “这里启动了一条 `session_memory`”
- “它是由 `post_sampling_hook` 机制触发的”
- “具体触发分支是 `token_threshold_and_natural_break`”
- “触发时的关键判定值是：token 增量已满足阈值，最近一轮已无 tool call”

也就是说，action 报告和日志阅读结果将从“结构可见”升级为“结构 + 因果可解释”。

### 具体回测示例

以历史真实样本：

- `user_action_id = 9ddd1bff-65b6-414f-bf04-418809eb6ff7`

为例，当前系统只能看到：

- 主线程 `turn-1` 后起了 `session_memory #1`
- 主线程 `turn-4` 后起了 `session_memory #2`
- 主线程完成后起了 `extract_memories`

补完本任务后，预期能读成：

#### `session_memory #1`

- `subagent_reason = session_memory`
- `subagent_trigger_kind = post_sampling_hook`
- `subagent_trigger_detail = token_threshold_and_tool_threshold`
- `subagent_trigger_payload`
  - `has_met_update_threshold = true`
  - `tool_calls_since_last_update = N`
  - `tool_call_threshold = M`

#### `session_memory #2`

- `subagent_reason = session_memory`
- `subagent_trigger_kind = post_sampling_hook`
- `subagent_trigger_detail = token_threshold_and_natural_break`
- `subagent_trigger_payload`
  - `has_met_update_threshold = true`
  - `has_tool_calls_in_last_turn = false`

#### `extract_memories`

- `subagent_reason = extract_memories`
- `subagent_trigger_kind = stop_hook_background`
- `subagent_trigger_detail = post_turn_background_extraction`
- `subagent_trigger_payload`
  - `feature_gate_enabled = true`
  - `auto_memory_enabled = true`
  - `in_progress = false`

最终效果是：

1. 日志阅读时不再需要大量猜测
2. `explain_action` 能直接解释“为什么这里分叉”
3. 后续可以按触发机制分析频率、成本和异常触发

---

## 1.2 设计思路

### 为什么不能只用现有字段

- `query_source` 只说明来源，不说明“为什么现在开”
- `subagent_type` 更偏实现标签，不够稳定
- `subagent_reason` 只能说明业务目的，仍不能说明本次触发契机

所以当前缺的不是“再起一个别名”，而是缺一层新的因果表达。

### 为什么要拆成 `kind + detail + payload`

因为这三层承担不同职责：

- `subagent_trigger_kind`
  - 适合做聚合统计
  - 例如：`post_sampling_hook / stop_hook_background / explicit_user_command`
- `subagent_trigger_detail`
  - 适合做人类可读解释
  - 例如：`token_threshold_and_tool_threshold`
- `subagent_trigger_payload`
  - 适合保留判定现场证据
  - 例如具体阈值、计数、布尔条件

如果把这三层揉成一个字段，后续要么不可统计，要么不可解释。

### 为什么必须在调用点写入

调用点最知道“为什么此刻开”：

- `sessionMemory.ts` 知道是哪条阈值分支命中
- `extractMemories.ts` 知道是不是 trailing run
- `sideQuestion.ts` 知道这是 `/btw`

所以：

- 事件层应优先由调用点显式传入 trigger 字段
- `runForkedAgent(...)` 只做统一承载，不做复杂推断
- ETL 只负责兼容旧日志，不能替代源码事实源

### 为什么不替换旧字段

因为旧字段仍然有价值，只是语义层级不同：

- `query_source`：来源
- `subagent_type`：实现标签
- `subagent_reason`：业务原因
- `subagent_trigger_*`：本次触发契机

正确做法是分层补充，而不是互相覆盖。

---

## 2. 本轮目标

本轮目标是新增一层稳定的“触发因果观测”，使系统能够同时表达：

1. 这条 subagent **属于什么业务目的**
2. 这条 subagent **是通过什么机制被触发的**
3. 这条 subagent **在该机制下具体走了哪条判定分支**
4. 必要时，保留当时判定所用的关键上下文事实

---

## 3. 非目标

本轮不做：

- 不重写 query loop 主结构
- 不新增新的 subagent 功能
- 不重构已有 `query_source` / `subagent_type` 的底层语义
- 不一次性做大量新 dashboard 面板
- 不修改远端平台或外部 exporter

---

## 4. 核心设计原则

### 4.1 不替代旧字段，只新增因果层

保留现有字段：

- `query_source`
- `subagent_type`
- `subagent_reason`

新增字段：

- `subagent_trigger_kind`
- `subagent_trigger_detail`
- `subagent_trigger_payload`

原因：

- `query_source` 表示来源
- `subagent_type` 表示实现标签
- `subagent_reason` 表示业务原因
- `subagent_trigger_*` 表示本次启动契机

这四层语义不同，不能强行合并成一个字段。

### 4.2 优先由调用点显式传值

原则：

- 触发因果字段应优先由**调用 `runForkedAgent(...)` 的模块**显式传入
- 不应主要依赖 `runForkedAgent(...)` 内部推断
- ETL 只能对历史日志做回退兼容，不能成为主事实源

原因：

- 调用点最知道“为什么在这时开”
- 框架层只知道“有人让我开了”

### 4.3 兼容旧日志

新字段对历史日志允许为空：

- `subagent_trigger_kind = null`
- `subagent_trigger_detail = null`
- `subagent_trigger_payload = null`

这样不会破坏已有 V1 库和阅读器。

---

## 5. 字段定义

### 5.1 `subagent_reason`

定义：

- 稳定业务原因
- 回答“这条 subagent 是为哪类业务目的存在的”

建议枚举：

- `session_memory`
- `extract_memories`
- `side_query`
- `prompt_suggestion`
- `compact`
- `auto_dream`
- `agent_summary`
- `speculation`

### 5.2 `subagent_trigger_kind`

定义：

- 触发机制大类
- 回答“这次启动是在哪种机制下被触发的”

建议枚举：

- `post_sampling_hook`
- `stop_hook_background`
- `explicit_user_command`
- `manual_command`
- `periodic_timer`
- `internal_pipeline`
- `compaction_flow`
- `direct_feature_entry`

### 5.3 `subagent_trigger_detail`

定义：

- 触发分支细节
- 回答“在该机制下，具体是哪条判定分支触发的”

示例值：

- `token_threshold_and_tool_threshold`
- `token_threshold_and_natural_break`
- `post_turn_background_extraction`
- `coalesced_trailing_run`
- `btw_command`
- `suggestion_generation_allowed`
- `prompt_cache_sharing_compact`
- `summary_interval_elapsed`
- `accepted_prompt_suggestion`

### 5.4 `subagent_trigger_payload`

定义：

- 触发时的关键判定上下文
- 用于记录具体阈值、开关、模式、计数等

类型：

- JSON 对象

示例：

```json
{
  "has_met_update_threshold": true,
  "tool_calls_since_last_update": 7,
  "has_tool_calls_in_last_turn": false
}
```

---

## 6. 首批覆盖范围

本轮先覆盖当前最核心、最常见的 forked agent 入口。

### 6.1 `session_memory`

调用点：

- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:325)

建议写入：

- `subagent_reason = session_memory`
- `subagent_trigger_kind = post_sampling_hook`
- `subagent_trigger_detail`
  - `token_threshold_and_tool_threshold`
  - 或 `token_threshold_and_natural_break`
- `subagent_trigger_payload`
  - `current_token_count`
  - `has_met_initialization_threshold`
  - `has_met_update_threshold`
  - `tool_calls_since_last_update`
  - `tool_call_threshold`
  - `has_tool_calls_in_last_turn`

### 6.2 `extract_memories`

调用点：

- [extractMemories.ts](/abs/path/E:/claude-code/src/services/extractMemories/extractMemories.ts:415)

建议写入：

- `subagent_reason = extract_memories`
- `subagent_trigger_kind = stop_hook_background`
- `subagent_trigger_detail`
  - `post_turn_background_extraction`
  - 或 `coalesced_trailing_run`
- `subagent_trigger_payload`
  - `feature_gate_enabled`
  - `auto_memory_enabled`
  - `remote_mode`
  - `in_progress`

### 6.3 `side_question`

调用点：

- [sideQuestion.ts](/abs/path/E:/claude-code/src/utils/sideQuestion.ts:80)

建议写入：

- `subagent_reason = side_query`
- `subagent_trigger_kind = explicit_user_command`
- `subagent_trigger_detail = btw_command`
- `subagent_trigger_payload`
  - `command = /btw`
  - `max_turns = 1`
  - `tools_allowed = false`

### 6.4 `prompt_suggestion`

调用点：

- [promptSuggestion.ts](/abs/path/E:/claude-code/src/services/PromptSuggestion/promptSuggestion.ts:319)

建议写入：

- `subagent_reason = prompt_suggestion`
- `subagent_trigger_kind = stop_hook_background`
- `subagent_trigger_detail = suggestion_generation_allowed`
- `subagent_trigger_payload`
  - `assistant_turn_count`
  - `suppress_reason = null`
  - `is_main_thread = true`

### 6.5 `compact`

调用点：

- [compact.ts](/abs/path/E:/claude-code/src/services/compact/compact.ts:1191)

建议写入：

- `subagent_reason = compact`
- `subagent_trigger_kind = compaction_flow`
- `subagent_trigger_detail = prompt_cache_sharing_compact`
- `subagent_trigger_payload`
  - `prompt_cache_sharing_enabled`
  - `skip_cache_write`
  - `max_turns = 1`

### 6.6 `auto_dream`

调用点：

- [autoDream.ts](/abs/path/E:/claude-code/src/services/autoDream/autoDream.ts:225)

建议写入：

- `subagent_reason = auto_dream`
- `subagent_trigger_kind = stop_hook_background`
- `subagent_trigger_detail = dream_consolidation_run`

### 6.7 `agent_summary`

调用点：

- [agentSummary.ts](/abs/path/E:/claude-code/src/services/AgentSummary/agentSummary.ts:115)

建议写入：

- `subagent_reason = agent_summary`
- `subagent_trigger_kind = periodic_timer`
- `subagent_trigger_detail = summary_interval_elapsed`

### 6.8 `speculation`

调用点：

- [speculation.ts](/abs/path/E:/claude-code/src/services/PromptSuggestion/speculation.ts:457)

建议写入：

- `subagent_reason = speculation`
- `subagent_trigger_kind = internal_pipeline`
- `subagent_trigger_detail = accepted_prompt_suggestion`

---

## 7. 事件层改动

### 7.1 修改 `ForkedAgentParams`

文件：

- [forkedAgent.ts](/abs/path/E:/claude-code/src/utils/forkedAgent.ts:83)

新增字段：

```ts
subagentTriggerKind?: string
subagentTriggerDetail?: string
subagentTriggerPayload?: Record<string, unknown>
```

### 7.2 修改 `runForkedAgent(...)`

文件：

- [forkedAgent.ts](/abs/path/E:/claude-code/src/utils/forkedAgent.ts:493)

要求：

- 在 `subagent.spawn.requested`
- `subagent.spawned`
- `subagent.completed`

中统一带出：

- `subagent_reason`
- `subagent_trigger_kind`
- `subagent_trigger_detail`

并把复杂对象放入：

- `payload.subagent_trigger_payload`

### 7.3 回退逻辑

要求：

- `subagent_reason` 继续保留当前回退：
  - `subagentReason ?? forkLabel ?? querySource ?? 'unknown'`
- `subagent_trigger_*` 不做复杂框架级推断
- 未显式传值时保持 `null`

---

## 8. ETL 改动

文件：

- [build_duckdb_etl.ts](/abs/path/E:/claude-code/scripts/observability/build_duckdb_etl.ts:1)

要求：

### 8.1 `events_raw`

新增列：

- `subagent_trigger_kind`
- `subagent_trigger_detail`
- `subagent_trigger_payload_json`

### 8.2 `queries`

新增列：

- `subagent_trigger_kind`
- `subagent_trigger_detail`

规则：

- 对于同一 query，优先取 `subagent.spawned`
- 否则回退到同链路内最早带值事件

### 8.3 `subagents`

新增列：

- `subagent_trigger_kind`
- `subagent_trigger_detail`
- `subagent_trigger_payload_json`

### 8.4 兼容旧日志

要求：

- 历史样本默认 `null`
- 不允许因旧日志缺字段而导致建库失败

---

## 9. 阅读器与展示层改动

本轮只做最小可读性接入，不扩张大面板。

### 9.1 `explain_action.ps1`

要求：

- 在 subagent 节点下展示：
  - `subagent_reason`
  - `subagent_trigger_kind`
  - `subagent_trigger_detail`

### 9.2 action 报告

要求：

- 在自然语言解释中，优先用 trigger 字段解释“为什么这里分叉”

### 9.3 dashboard / daily summary

本轮非必须，仅做以下最小增强之一即可：

- `Subagent Reason 明细` 表增加 `trigger_kind / trigger_detail`
  或
- 新增一张极小的 `Subagent Trigger 明细` 表

不要求新增复杂图表。

---

## 10. 验证要求

### 10.1 代码验证

- `typecheck` 通过
- ETL 可正常重建
- `daily_summary.ps1` 可正常运行
- `explain_action.ps1` 可正常生成报告

### 10.2 日志验证

使用新的 debug 样本验证至少这几类：

- `session_memory`
- `extract_memories`
- 如可复现，再加 `side_question`

### 10.3 功能验证目标

验证时应能明确回答：

- 这条 subagent 是什么业务原因
- 这条 subagent 是通过什么机制触发的
- 这次具体是哪条触发分支

---

## 11. 验收标准

完成后，系统至少应满足：

1. `subagent.spawn.requested / spawned / completed` 三类事件能稳定带出触发因果字段
2. DuckDB 中可以按 `subagent_trigger_kind` / `subagent_trigger_detail` 查询
3. `explain_action` 生成的 action 报告能解释“为什么这里启动了这条 subagent”
4. 历史旧日志不因新字段而失效
5. 原有 `query_source / subagent_type / subagent_reason` 语义不被破坏

---

## 12. 推荐实施顺序

1. 先改 `forkedAgent.ts` 参数和事件 schema
2. 再改 `session_memory / extract_memories / side_question` 三个最关键调用点
3. 再改 ETL
4. 最后改 `explain_action.ps1`

理由：

- 先把事实源打稳
- 再把阅读器接上
- 避免先改展示层却没有真实字段支撑

---

## 13. 一句话总结

本任务不是再给 subagent 起一个新名字，而是要把：

- **它是什么**
- **为什么有它**
- **为什么在这一刻启动它**

这三层语义正式拆开，形成稳定的 V1 因果观测能力，为后续 V2/V3 扩展打基础。
