# Subagent 触发因果执行清单

## 理解清单

- 这份清单只覆盖首批可落地实现，不继续扩张更多面板
- 实现顺序是：
  1. 事件 schema
  2. 首批调用点
  3. ETL
  4. `explain_action`
  5. 验证
- 第一批重点覆盖：
  - `session_memory`
  - `extract_memories`
  - `side_question`
  - 同时补上 `prompt_suggestion / compact / auto_dream / agent_summary / speculation`

## 预期效果

- 新日志里，`subagent.spawn.requested / spawned / completed` 都会带：
  - `subagent_trigger_kind`
  - `subagent_trigger_detail`
  - `payload.subagent_trigger_payload`
- DuckDB 中可以查询：
  - 某条 subagent 是什么 reason
  - 它是通过什么机制触发的
  - 具体触发分支是什么
- `explain_action` 报告里可以直接写：
  - “这里启动了一条 `session_memory`，由 `post_sampling_hook` 机制触发，具体分支是 `token_threshold_and_natural_break`”

## 设计思路

- 不替换旧字段，只补因果层
- 触发字段优先由调用点显式传入，不让 ETL 事后猜主事实
- ETL 只做兼容旧日志
- 展示层先接入 action 报告，不扩张大 dashboard

## 执行步骤

1. 扩 `HarnessEventInput`
   - 增加 `subagent_trigger_kind`
   - 增加 `subagent_trigger_detail`

2. 扩 `ForkedAgentParams`
   - 增加 `subagentTriggerKind`
   - 增加 `subagentTriggerDetail`
   - 增加 `subagentTriggerPayload`

3. 修改 `runForkedAgent(...)`
   - 三类事件统一落 trigger 字段：
     - `subagent.spawn.requested`
     - `subagent.spawned`
     - `subagent.completed`

4. 修改首批调用点
   - `sessionMemory.ts`
   - `extractMemories.ts`
   - `sideQuestion.ts`
   - `promptSuggestion.ts`
   - `compact.ts`
   - `autoDream.ts`
   - `agentSummary.ts`
   - `speculation.ts`

5. 修改 ETL
   - `events_raw` 新增 trigger 列
   - `queries` 新增 trigger 列
   - `subagents` 新增 trigger 列

6. 修改 `explain_action.ps1`
   - 查询并展示 trigger 字段
   - 在 Markdown 报告中输出 trigger 说明

7. 验证
   - `typecheck`
   - 重建 DuckDB
   - 生成最新 action 报告
