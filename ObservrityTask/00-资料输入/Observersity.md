# 给 Codex 的正式任务书

## 1. 项目背景

我正在为一个基于还原源码运行的 harness 项目建设一套**高质量、可扩展、可维护的埋点与可观测基础设施**。
我同时会提供两类材料：

1. **当前项目源码**：这是你可以直接读取和修改的代码。
2. **一份 PDF 文档**：这份 PDF 是基于“原始/上游源码分析”得到的 query loop 与 harness 运行流程讲解。它描述的是**理论主链与关键设计意图**，但**不保证与当前还原项目完全一致**。PDF 把 `queryLoop` 描述为一个“模型采样 → assistant/tool_use → tool 执行 → tool_result 回灌 → 下一轮”的状态机式主编排器。

因此，你在实现埋点时必须遵守这个前提：

* **不能默认 PDF 与当前项目完全一致**
* **不能默认当前项目一定保留了 PDF 中所有功能**
* **必须主动核对 PDF 中的重要节点，在当前项目里是：**

  * 仍然存在
  * 被关闭
  * 被轻度改写
  * 被重写为不同语义
  * 或已经删除

---

## 2. 核心任务目标

你的任务分成两部分，必须同时完成。

### A. 结构化核对当前项目与 PDF 主链的一致性

请以 PDF 描述的主链为“理论蓝图”，逐段核对当前项目源码中对应实现是否仍存在，并形成清单：

* 节点是否存在
* 入口函数 / 文件位置
* 当前语义是否与 PDF 一致
* 是否被 feature flag / env / gate / 组织配置关闭
* 是否仅保留壳子但内部行为已变化
* 是否完全缺失

### B. 在“当前项目真实存在的运行链路”上实现统一埋点体系

请以**当前项目源码为准**完成埋点，不要把 PDF 当成绝对真相硬套。
如果 PDF 某节点已经不存在，你应：

* 保留该节点在埋点设计中的位置
* 但将实现标记为 `disabled` / `not_present` / `rewritten`
* 并在最终报告中说明

---

## 3. 冲突处理原则（必须严格执行）

如果你在核对或实现中发现 **PDF 与当前项目源码存在重要矛盾**，你必须**立即暂停相关推进并向我确认**。不要自行拍板做语义假设。

### 需要立即找我确认的典型场景

1. PDF 明确存在的关键节点，在当前项目中找不到。
2. 节点名还在，但语义明显变了。
3. PDF 说有某条恢复链 / 工具调度链，但当前项目走的是另一套机制。
4. 代码里有多个可能对应 PDF 某节点的实现，且它们语义互斥。
5. 当前项目中该节点被 flag / gate 关闭，而你不确定应只埋点保留现状，还是尝试恢复开启。
6. 你发现当前项目只是“轻度还原”，有明显 stub / mock / no-op / placeholder 痕迹。

### 遇到冲突时你的行为要求

你必须输出一段这样的说明并等我确认：

* **冲突点名称**
* **PDF 中的原意**
* **当前项目里的实际情况**
* **你认为可能的解释**
* **你建议的处理方案 A / B**
* **你当前暂停的位置**

---

## 4. 任务范围

请至少覆盖以下 harness / 子系统：

### 4.1 用户输入与提交层

* 提交入口
* `submitMessage` / 对应入口
* `processUserInput` / 输入归一化
* slash command / attachments / prompt augmentations
* file history snapshot

### 4.2 query / queryLoop 主循环

* `query()`
* `queryLoop()`
* `State` 初始化与每轮 state 迁移
* `turnCount / loop_iter / transition`
* `queryTracking`

### 4.3 messages 预处理链

核对并埋点以下阶段是否存在、是否生效：

* `getMessagesAfterCompactBoundary`
* `applyToolResultBudget`
* `HISTORY_SNIP`
* `microcompact`
* `contextCollapse`
* `autocompact`

### 4.4 Prompt 构建层

* system prompt 构建
* CLAUDE.md / rules / memory / skills / attachments 注入
* tool names / companion / extra context
* 完整 request snapshot
* request 摘要统计

### 4.5 模型请求与流式响应层

* `callModel`
* request 发起
* first chunk
* assistant blocks
* `tool_use`
* response 快照
* usage / stop reason / fallback / withheld errors

### 4.6 工具调度与执行层

* `StreamingToolExecutor`
* `runTools`
* 并发 / 串行 batch
* tool enqueue / start / progress / complete / fail
* normalize messages
* contextModifier / newContext

### 4.7 恢复链 / stop hooks / token budget

核对并埋点这些路径是否还存在：

* prompt-too-long recover
* media-size recover
* max_output_tokens recover
* `handleStopHooks`
* token budget continuation
* terminal reason

### 4.8 子 agent / 分叉链路

必须纳入统一观测模型：

* `extract_memories`
* `session_memory`
* `away_summary`
* `side_query`
* 以及你在源码中发现的其他 fork / subagent 类型

日志已经证明至少 `extract_memories` 与 `session_memory` 会触发并发起自己的 prompt、工具调用、文件写入。

---

## 5. 设计要求

### 5.1 不能只补零散 DEBUG

请实现一套**统一结构化事件模型**，以 JSONL 作为事实源。
控制台日志可以保留，但不是后续可观测系统的主数据源。

### 5.2 所有关键事件必须可关联

事件必须能串成：

* 一次用户动作
* 一个 query
* query 内多轮 turn
* 主线程与子 agent
* tool 调用链
* 恢复链
* 终止原因

### 5.3 必须兼顾“完整内容记录”与“可维护性”

我要求能够记录：

* 用户发送的完整内容
* 每轮完整 system prompt
* 每轮完整 request / response
* 每轮 state
* 每次工具输入输出

但这些大对象不能全部直接塞进主事件里。
请实现：

* **主事件：结构化摘要**
* **sidecar snapshots：完整内容**
* 主事件里只存：`snapshot_ref + bytes + sha256 + redaction_state`

### 5.4 必须可扩展

后续我要基于这套埋点继续建设可观测系统。
因此你要保证：

* schema 版本化
* event 命名稳定
* 字段命名规范
* 后续容易接 trace / dashboard / metrics 聚合

---

## 6. 统一日志/事件规范

请实现统一函数，例如：

* `emitHarnessEvent(...)`
* 或等价的统一埋点层

### 6.1 事件公共字段

每个事件至少包含：

* `schema_version`
* `ts_wall`
* `ts_mono_ms`
* `level`
* `event`
* `component`
* `session_id`
* `conversation_id`
* `user_action_id`
* `query_id`
* `turn_id`
* `loop_iter`
* `parent_turn_id`
* `subagent_id`
* `subagent_type`
* `query_source`
* `request_id`
* `tool_call_id`
* `span_id`
* `parent_span_id`
* `cwd`
* `git_branch`
* `build_version`
* `payload`

### 6.2 命名规范

事件名统一使用：

* `domain.action.stage`

例如：

* `submit.attempted`
* `input.process.completed`
* `messages.preprocess.completed`
* `api.request.started`
* `assistant.tool_use.detected`
* `tool.execution.completed`
* `subagent.spawned`
* `state.transitioned`
* `query.terminated`

### 6.3 文件组织

建议：

```text id="h3ie7q"
.observability/events-YYYYMMDD.jsonl
.observability/snapshots/{id}-request.json
.observability/snapshots/{id}-response.json
.observability/snapshots/{id}-state-before.json
.observability/snapshots/{id}-state-after.json
.observability/snapshots/{tool_call_id}-input.json
.observability/snapshots/{tool_call_id}-output.json
```

---

## 7. 必须实现的事件清单

请至少实现以下事件。
如果某些节点在当前项目中已经不存在，请不要直接删除该事件定义，而要在实现或最终报告中标注 `not_present` / `disabled` / `rewritten`。

### 7.1 提交与输入层

* `submit.attempted`
* `submit.blocked`
* `input.process.started`
* `input.process.completed`
* `file_history.snapshot.created`

### 7.2 query / state 初始化层

* `query.started`
* `state.initialized`
* `prefetch.memory.started`
* `turn.started`
* `query_tracking.assigned`

### 7.3 messages 预处理链

* `messages.compact_boundary.applied`
* `messages.tool_result_budget.applied`
* `messages.history_snip.applied`
* `messages.microcompact.applied`
* `messages.context_collapse.applied`
* `messages.autoconpact.checked`
* `messages.autoconpact.completed`
* `messages.preprocess.completed`

### 7.4 prompt / request 构建层

* `prompt.build.started`
* `prompt.build.completed`
* `prompt.snapshot.stored`

### 7.5 API / streaming 层

* `api.request.started`
* `api.stream.first_chunk`
* `assistant.block.received`
* `assistant.tool_use.detected`
* `api.fallback.triggered`
* `api.error.withheld`
* `api.stream.completed`

### 7.6 工具执行层

* `tool.execution.mode.selected`
* `tool.enqueued`
* `tool.batch.started`
* `tool.execution.started`
* `tool.progress`
* `tool.execution.completed`
* `tool.execution.failed`
* `tool.result.normalized`
* `tool.context.updated`

### 7.7 恢复 / stop hooks / token budget

* `recovery.prompt_too_long.attempted`
* `recovery.prompt_too_long.completed`
* `recovery.max_output_tokens.attempted`
* `recovery.max_output_tokens.completed`
* `stop_hooks.started`
* `stop_hooks.completed`
* `token_budget.decision`

### 7.8 state 转移层

* `state.snapshot.before_turn`
* `state.snapshot.after_turn`
* `state.transitioned`

### 7.9 子 agent 层

* `subagent.spawn.requested`
* `subagent.spawned`
* `subagent.message.received`
* `subagent.prompt.build.completed`
* `subagent.tool.summary`
* `subagent.completed`

### 7.10 query 终止层

* `query.terminated`

---

## 8. 每个关键事件必须包含的重点信息

### 8.1 `input.process.completed`

必须能回答：

* 用户原始输入是什么
* 最终生成了哪些 messages
* 附件如何归一化
* slash command 如何被处理
* 传给 `query()` 的 `QueryParams` 摘要是什么

### 8.2 `messages.*`

每一级预处理必须记录：

* `messages_before`
* `messages_after`
* `estimated_tokens_before`
* `estimated_tokens_after`
* `tokens_saved`
* `attachments_before/after`
* `tool_results_before/after`
* `snapshot_before_ref`
* `snapshot_after_ref`

### 8.3 `prompt.build.completed`

必须记录：

* `provider`
* `query_source`
* `model`
* `system_prompt_segments_count`
* `system_prompt_chars`
* `claude_md_chars`
* `memory_chars`
* `skill_listing_chars`
* `tool_names_count`
* `tool_names_chars`
* `companion_intro_chars`
* `messages_chars_total`
* `attachments_chars_total`
* `serialized_request_bytes`
* `request_snapshot_ref`

### 8.4 `assistant.block.received`

必须能区分：

* text
* tool_use
* thinking
* error

### 8.5 `tool.execution.*`

必须能回答：

* 是 `StreamingToolExecutor` 还是 `runTools`
* 是串行还是并行
* tool 输入是什么
* tool 输出是什么
* 有没有 `contextModifier` / `newContext`
* 执行耗时
* 是否成功
* 是否触发 synthetic error / sibling error

### 8.6 `state.transitioned`

必须能回答：

* 为什么继续下一轮
* 从哪个 state 到哪个 state
* messages 增加了什么
* token 估计变化了多少
* `ToolUseContext` 是否变化

### 8.7 `subagent.*`

必须能回答：

* 子 agent 由谁触发
* 为什么触发
* 继承了什么上下文
* 跑了几轮
* 调了哪些工具
* 写了哪些文件
* 总 usage 是多少
* 为什么结束

---

## 9. PDF 与当前项目的一致性核对任务（必须单独产出）

请单独产出一份“**PDF 主链核对报告**”，至少包含下表：

* PDF 节点名
* PDF 原意摘要
* 当前项目对应文件 / 函数 / 类
* 当前状态：`present` / `disabled` / `rewritten` / `deleted` / `uncertain`
* 证据
* 处理建议

至少核对以下节点：

* `QueryEngine.submitMessage`
* `processUserInput`
* `query`
* `queryLoop`
* `State`
* `getMessagesAfterCompactBoundary`
* `applyToolResultBudget`
* `HISTORY_SNIP`
* `microcompact`
* `contextCollapse`
* `autocompact`
* `callModel`
* `StreamingToolExecutor`
* `runTools`
* `handleStopHooks`
* prompt-too-long recover
* max_output_tokens recover
* token budget continuation
* subagent 触发链

如果你发现：

* 某节点被删除
* 某节点被不同语义替代
* 某节点被 feature flag 彻底封住
* 某节点只剩壳子

请立即找我确认，不要自行把 PDF 语义硬套到当前项目。

---

## 10. 与我沟通的强制要求

在以下情况必须立即找我确认：

1. 你发现 PDF 与当前项目主链存在明显冲突。
2. 某个关键节点存在多个候选实现，且意义不同。
3. 你不确定某个功能是“关闭了”还是“重写了”。
4. 你准备恢复开启一个当前默认关闭的节点。
5. 你发现现有代码中的日志/埋点体系本身就有另一套设计，与本任务方案冲突。
6. 你要改动的点会影响行为而不仅仅是加日志。

你找我确认时必须使用这种格式：

* 冲突点：
* PDF 中的描述：
* 当前项目中的真实情况：
* 我目前的判断：
* 候选处理方案 A：
* 候选处理方案 B：
* 我暂停在这里等待确认：

---

## 11. 实现顺序

请按下面顺序推进，不要一开始就全铺开。

### Phase 1：核对与骨架建立

* 阅读当前项目源码
* 对照 PDF 做主链核对
* 建立统一事件模型
* 建立 JSONL + snapshot 基础设施
* 先打通主线程核心链路

### Phase 2：主线程完整链路埋点

* 提交/输入
* query/queryLoop/state
* preprocess 链
* prompt build
* API request / stream
* query terminate

### Phase 3：工具与 state 深化

* tool detection / mode / execution
* state snapshots
* state transitions
* tool result normalization
* context updates

### Phase 4：子 agent 与恢复链

* subagent lifecycle
* stop hooks
* recovery
* token budget

---

## 12. 验收标准

只有满足以下条件，任务才算完成：

### A. 结构化一致性

* 所有新埋点使用统一事件模型
* 事件字段命名一致
* 有 schema version
* 有 clear event naming

### B. 流程覆盖度

能够从日志中完整还原：

* 一次用户提交
* 主线程多轮 turn
* 每轮 state 变化
* 每轮 preprocess/压缩动作与效果
* 每轮 prompt build
* 每次 API request / response
* 每个 tool_use / tool_result
* 工具调度模式
* 子 agent 的触发与行为
* query 终止原因

### C. 大对象可追溯

* request/response/state/tool input/tool output 均可通过 snapshot_ref 找到
* snapshot 有 hash、bytes、redaction 标记

### D. 冲突显式化

* 已产出 PDF 主链核对报告
* 所有 `disabled` / `rewritten` / `deleted` 节点都被明确标注
* 所有重大冲突都已向我确认

### E. 不破坏主流程

* 默认行为不应因埋点而改变
* 埋点层尽量旁路，不影响 query loop 语义

---

## 13. 最终交付物

请最终提交这些内容：

1. **代码修改**：实现统一埋点体系
2. **事件 schema 文档**
3. **PDF 主链核对报告**
4. **已实现事件清单**
5. **未实现/不存在/关闭节点清单**
6. **你在实现过程中发现并与我确认过的冲突清单**
7. **一份示例日志**：能展示一次完整用户动作跨主线程 + 子 agent 的全链路事件

---

## 14. 最后原则

请记住：

* **以当前项目源码为实现真相**
* **以 PDF 为理论蓝图与核对清单**
* **发现矛盾时立即找我确认**
* **不要擅自把 PDF 语义硬套到当前项目**
* **不要用零散 DEBUG 代替统一埋点系统**

---


