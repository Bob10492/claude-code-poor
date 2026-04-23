# Query Loop 全流程详解（源码版）

本文基于**当前源码真实实现**整理，目标是替代早期较粗略的流程介绍材料，帮助你从源码角度完整理解：

1. 一次主线程 `query` 到底从哪里开始
2. 一个 `query loop` 每一轮在做什么
3. 什么时机会判断要不要继续、要不要执行工具、要不要启动旁路/子 agent
4. 为什么一次用户动作会展开成多条 query、多轮 turn，甚至多条子链路

本文关注的是**主线程 `query()` / `queryLoop()` 的真实时间顺序**，并补充它和：

- `session_memory`
- `extract_memories`
- `side_question`
- `prompt_suggestion`
- `compact`

之间的关系。

---

## 1. 先建立几个最重要的概念

如果不先区分这几个层级，很容易把整个系统看乱。

### 1.1 `user_action`

这是“用户这次动作”的根，比如用户发送了一次消息。

它是整个执行树的根键。  
一次 `user_action` 可以展开成：

- 1 条主线程 query
- 0 到多条子 query
- 多轮 turn
- 多次工具调用

### 1.2 `query`

这是一次完整的 query 生命周期。

主线程的主执行链是一条 query。  
每个通过 `runForkedAgent(...)` 启动的 forked subagent，也会有自己独立的一条 query。

所以：

- 一个 `user_action` 往往不止一条 query
- 一个 `query` 可以包含多轮 turn

### 1.3 `turn`

可以把它理解成 query loop 的“一轮”。

一轮通常包含：

1. 取当前 messages
2. 做预处理
3. 组 prompt
4. 调模型
5. 读响应
6. 处理 tool_use / stop hook / continuation 决策

如果 assistant 决定继续使用工具，或者系统决定继续下一轮，那么 query 不结束，而是进入下一轮 turn。

### 1.4 `tool call`

这是 assistant 输出的某个 `tool_use` block 最终对应的一次工具执行生命周期。

### 1.5 `forked subagent`

最典型的技术特征是：

- 由 `runForkedAgent(...)` 启动
- 拥有自己的隔离上下文
- 内部再次调用 `query(...)`
- 因此拥有自己的 `query_id / turn / tool` 轨迹

这一点非常关键：

**每次 `runForkedAgent(...)` 都不是“插入主线程的一小段逻辑”，而是重新启动一条新的 query loop。**

证据在：

- [forkedAgent.ts](/abs/path/E:/claude-code/src/utils/forkedAgent.ts:588)

这里 `runForkedAgent(...)` 内部直接：

```ts
for await (const message of query({ ... })) {
```

---

## 2. `query()` 和 `queryLoop()` 的关系

真正的入口在：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:527)

外层函数是：

- `query(params)`

它主要负责：

1. 包一层 Langfuse trace 生命周期
2. 调内部真正的主循环 `queryLoop(...)`
3. 在结束时补 trace 关闭和 command lifecycle 完成

所以：

- `query()` 是外层壳
- `queryLoop()` 是真正的执行状态机

内部真实主循环从这里开始：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:586)

---

## 3. 主线程一次 query 的完整时间顺序

下面按源码真实顺序讲。

---

## 4. 第 0 阶段：进入 `query()`，创建外层 trace

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:527)

主要逻辑：

1. 初始化 `consumedCommandUuids`
2. 如有需要，创建 Langfuse trace
3. 把 trace 塞回 `toolUseContext`
4. `yield* queryLoop(...)`
5. 结束时关闭 trace

### 这一层的作用

这层不是 query loop 本身，而是给整个 query 生命周期包一个外壳：

- tracing
- lifecycle 收尾
- command queue 生命周期通知

### 实现思路

把“真正做事的逻辑”和“外围观测/trace 生命周期”分开。  
这让 `queryLoop()` 可以只关心状态机本身。

---

## 5. 第 1 阶段：`queryLoop()` 初始化全局状态

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:586)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:613)

初始化的核心状态包括：

- `state.messages`
- `state.toolUseContext`
- `state.turnCount = 1`
- `state.maxOutputTokensRecoveryCount = 0`
- `state.hasAttemptedReactiveCompact = false`
- `state.pendingToolUseSummary = undefined`
- `state.transition = undefined`

还会初始化：

- `budgetTracker`
- `taskBudgetRemaining`
- `config = buildQueryConfig()`

并立刻发出：

- `state.initialized`
- `prefetch.memory.started`

对应位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:641)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:665)

### 这一层的作用

这是整个 query loop 的“状态机底座”。

它把：

- 当前 messages
- 当前 turn 计数
- 当前 recovery 状态
- 当前预算状态

都放进一个可持续推进的 `State` 中。

### 实现思路

不是在循环里散落一堆变量，而是维护一个统一 `state`，每次进入下一轮时整体替换 `state = next`。  
这样每个“继续点”都能清楚表达：

- 这轮结束后留下了什么状态
- 下一轮要从什么状态继续

---

## 6. 第 2 阶段：进入 while(true)，开始第 N 轮 turn

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:722)

每次进入一轮时，会：

1. 从 `state` 解构出本轮要用的变量
2. 启动技能发现预取 `pendingSkillPrefetch`
3. `yield { type: 'stream_request_start' }`
4. 初始化 / 递增 `queryTracking`
5. 计算 `turnId = turn-${turnCount}`

其中 `queryTracking` 很关键：

- 第一次进来时创建新的 `chainId`
- 之后继续沿用同一个 `chainId`
- 但 `depth` 会递增

对应位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:762)

然后会发事件：

- `query.started`（只在第一轮）
- `query_tracking.assigned`
- `turn.started`
- `state.snapshot.before_turn`

对应位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:781)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:800)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:813)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:827)

### 这一层的作用

这一层定义了：

- 这是不是某条 query 的第一轮
- 当前是哪一轮
- 当前这轮进入前的状态是什么

### 实现思路

每轮都先把“身份”和“快照”记录清楚，然后才开始做真实处理。  
这就是为什么后面的完整性指标能闭合到 `turn` 级别。

---

## 7. 第 3 阶段：消息预处理流水线

这是 query loop 非常关键的一段。  
它做的事情不是“调用模型”，而是先把要发给模型的上下文整理成当前最合适的版本。

本轮会按顺序执行这些步骤。

### 7.1 `getMessagesAfterCompactBoundary`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:836)

作用：

- 从完整消息历史中取出 compact boundary 之后的那部分消息
- 也就是当前应该参与本轮请求的可见对话区间

事件：

- `messages.compact_boundary.applied`

### 7.2 `applyToolResultBudget`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:861)

作用：

- 给工具结果做大小预算控制
- 防止某些 tool result 太大直接膨胀上下文

事件：

- `messages.tool_result_budget.applied`

### 7.3 `history_snip`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:895)

作用：

- 在特定条件下剪掉历史部分内容
- 并返回 `tokensFreed`

事件：

- `messages.history_snip.applied`

### 7.4 `microcompact`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:925)

作用：

- 对消息进行更细粒度压缩
- 例如对 tool result 或缓存可编辑区做更轻量的处理

事件：

- `messages.microcompact.applied`

### 7.5 `contextCollapse`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:965)

作用：

- 把已经可以折叠的上下文投影成 collapsed view
- 尽量在不做完整 compact summary 的情况下减小上下文压力

事件：

- `messages.context_collapse.applied`

### 7.6 `autocompact`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1006)

作用：

- 检查是否需要正式 autocompact
- 如果触发，会生成 compact summary，并用 post-compact messages 替换当前可见上下文

事件：

- `messages.autoconpact.checked`
- `messages.autoconpact.completed`

### 7.7 整体预处理完成

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1111)

事件：

- `messages.preprocess.completed`

### 这一整段的作用

这段代码的核心目标是：

**在真正调用模型之前，把 messages 调整到“尽量小、尽量合理、仍保持上下文有效”的状态。**

### 实现思路

它不是只有一种压缩手段，而是一个分层流水线：

1. 先做轻量预算控制
2. 再做历史裁剪
3. 再做微压缩
4. 再做 collapse
5. 最后再决定是否真的 autocompact

这样做的好处是：

- 尽量避免一上来就做重型 compact
- 先尝试保留更细粒度的上下文结构

---

## 8. 第 4 阶段：准备本轮模型调用环境

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1132)

这时会初始化本轮模型调用要用的临时变量：

- `assistantMessages`
- `toolResults`
- `toolUseBlocks`
- `needsFollowUp`
- `streamingToolExecutor`
- `currentModel`
- `dumpPromptsFetch`

### 这一层的作用

这是“正式调模型前的本轮 runtime setup”。

它和前面的预处理不同，前面处理的是 messages；  
这里准备的是：

- 本轮 assistant 响应收集容器
- 本轮 tool 执行器
- 本轮选用的模型
- 本轮调试/抓 prompt 的 fetch wrapper

### 关键点

这一层之后，代码就真正准备开始调用模型了。

---

## 9. 第 5 阶段：阻塞阈值检查

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1173)

作用：

- 在某些条件下，如果上下文已经到硬阻塞极限，直接报 `prompt_too_long`
- 保留空间给用户手动 `/compact`

终止路径：

- `emitQueryTerminated('blocking_limit')`

### 实现思路

在真正 API 调用前做一次硬保护，避免明显会失败的请求白白发出去。

---

## 10. 第 6 阶段：真正开始本轮模型调用

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1233)

这里进入 `attemptWithFallback` 内层循环。  
这个循环的含义是：

- 本轮 turn 原则上要调一次模型
- 但如果遇到 fallback 条件，可以切换 fallback model 再重试一次

---

## 11. 第 7 阶段：构建 prompt

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1241)

主要步骤：

1. `prependUserContext(messagesForQuery, userContext)`
2. `summarizePromptComposition(...)`
3. 存 `request` snapshot
4. 发：
   - `prompt.build.started`
   - `prompt.snapshot.stored`
   - `prompt.build.completed`
   - `api.request.started`

对应位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1241)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1263)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1285)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1334)

### 这一层的作用

把“最终发给模型的内容”完全定稿，并把它存证到 snapshot。

### 实现思路

这里把 prompt 视为一个可审计对象，而不是只在内存里临时拼一下就发出去。  
因此：

- 你后面能做 prompt token 分析
- 能做 request snapshot 还原
- 能检查 system prompt / userContext / messages 到底各占多少

---

## 12. 第 8 阶段：流式接收模型响应

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1360)

真正模型调用通过：

- `deps.callModel(...)`

进行。

它会持续产出流式消息，query loop 一边收，一边处理。

### 12.1 第一块流到达

第一次收到 chunk 时：

- 发 `api.stream.first_chunk`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1416)

### 12.2 处理 streaming fallback

如果 streaming fallback 发生：

- tombstone 已经收到的 orphan assistant messages
- 清空当前暂存的 `assistantMessages / toolResults / toolUseBlocks`
- 重建 `StreamingToolExecutor`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1432)

### 12.3 处理 assistant block

每收到 assistant message，会：

1. 发 `assistant.block.received`
2. 如果 block 是 `tool_use`，发 `assistant.tool_use.detected`
3. 把 assistant message 存入 `assistantMessages`
4. 把 `tool_use` block 存入 `toolUseBlocks`
5. 设置 `needsFollowUp = true`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1473)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1487)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1584)

### 12.4 流式工具执行

如果开启 `StreamingToolExecutor`：

- assistant 一边流出 `tool_use`
- executor 一边接收 tool block
- 已完成的工具结果会被尽快收割进 `toolResults`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1596)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1606)

### 12.5 响应结束

流结束后会：

1. 存 `response` snapshot
2. 发 `api.stream.completed`

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1624)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1631)

### 这一整段的作用

这是 query loop 最核心的一段：

- 与模型交互
- 收集 assistant 输出
- 识别 tool_use
- 决定本轮是否需要继续

### 实现思路

这段不是“等模型整段输出完了再统一处理”，而是：

- **边流边观察**
- 尽可能早发现工具调用
- 尽可能早启动流式工具执行

这就是为什么这套系统不是简单的一问一答，而是一个 agentic loop。

---

## 13. 第 9 阶段：模型调用错误与 fallback

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1675)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:1746)

这里处理几类问题：

### 13.1 模型 fallback

如果抛出 `FallbackTriggeredError`：

- 切换到 fallback model
- 清空本次失败尝试的 assistant/tool 状态
- 必要时 strip signature blocks
- 重新进入本轮模型调用

### 13.2 图片类错误

- `ImageSizeError`
- `ImageResizeError`

会终止为：

- `image_error`

### 13.3 普通模型错误

会：

- 补 missing tool_result blocks
- 发 abandoned tool_use 事件
- 产出 API error message
- `emitQueryTerminated('model_error')`

### 实现思路

把：

- 可恢复错误
- 可 fallback 错误
- 直接终止错误

分开处理，而不是所有错误都一刀切。

---

## 14. 第 10 阶段：post-sampling hooks

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1807)

只要本轮有 assistant 响应，就会：

- `executePostSamplingHooks(...)`

### 这是整个系统的第一个重要“分叉检查点”

它不是主线程直接决定“我要不要开 session memory”，而是：

1. 主线程一轮模型响应结束
2. 调 post-sampling hooks
3. 某个 hook 自己判断是否要 fork

最典型的是 `session_memory`：

- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:382)
  - 注册 `extractSessionMemory`
- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:303)
  - `if (!shouldExtractMemory(messages)) return`
- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:325)
  - `runForkedAgent(...)`

这说明：

**主线程并不是“运行到某一行突然强制开一个 session_memory”。**  
而是本轮结束后统一执行 hook，由 hook 判断此刻是否满足后台记忆更新条件。

---

## 15. 第 11 阶段：处理流式中断

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1819)

如果用户在 streaming 阶段中断：

- 收尾剩余流式工具结果
- 或补 synthetic tool_result
- 做 computer use cleanup
- 产出 interruption message
- `emitQueryTerminated('aborted_streaming')`

---

## 16. 第 12 阶段：如果本轮没有 tool_use，进入“收尾 / 终止 / 恢复”路径

判断条件：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1881)

即：

- `if (!needsFollowUp)`

含义是：

assistant 这轮没有提出新的工具调用。  
这时系统会判断：

1. 是不是该恢复重试
2. 是不是该 stop hooks
3. 是不是该 token budget continuation
4. 还是直接完成 query

这是一条非常重要的分支。

---

## 17. 第 13 阶段：恢复链

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:1884) 之后

包括：

### 17.1 prompt-too-long / media recovery

- `contextCollapse.recoverFromOverflow(...)`
- `reactiveCompact.tryReactiveCompact(...)`

如果成功，会构造 `next` state，并 `continue` 进入下一轮。

对应 transition：

- `collapse_drain_retry`
- `reactive_compact_retry`

### 17.2 max_output_tokens recovery

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2046)

包括两种：

1. 提升 `maxOutputTokensOverride`
   - `max_output_tokens_escalate`
2. 注入 recovery user message，继续下一轮
   - `max_output_tokens_recovery`

### 实现思路

系统把 recoverable 错误尽量当成：

**“状态转移后继续下一轮”**

而不是立刻把 query 打死。

这也是 `state.transitioned` 存在的意义之一。

---

## 18. 第 14 阶段：stop hooks

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2164)
- [stopHooks.ts](/abs/path/E:/claude-code/src/query/stopHooks.ts:66)

这是第二个重要“分叉检查点”。

主线程会在一轮收尾时进入 `handleStopHooks(...)`。

这里会做几类事：

1. 执行 stop hooks 本身
2. 保存 cache-safe params
3. 触发若干后台逻辑：
   - `executePromptSuggestion(...)`
   - `executeExtractMemories(...)`
   - `executeAutoDream(...)`

对应源码：

- [stopHooks.ts](/abs/path/E:/claude-code/src/query/stopHooks.ts:155)

### 这意味着什么

如果你问：

**“主线程什么时候会考虑开 `extract_memories`？”**

答案就是：

**在 stop hook 阶段。**

调用链大致是：

```text
queryLoop()
-> handleStopHooks()
-> executeExtractMemories()
-> executeExtractMemoriesImpl()
-> guard 条件通过
-> runForkedAgent()
```

而 `executeExtractMemoriesImpl()` 的 guard 在：

- [extractMemories.ts](/abs/path/E:/claude-code/src/services/extractMemories/extractMemories.ts:528)

真正 fork 在：

- [extractMemories.ts](/abs/path/E:/claude-code/src/services/extractMemories/extractMemories.ts:415)

---

## 19. 第 15 阶段：token budget 决策

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2223)

如果 `TOKEN_BUDGET` feature 开启：

- `checkTokenBudget(...)`

可能返回：

1. `continue`
   - 注入一条 meta user message
   - `transition = token_budget_continuation`
   - 进入下一轮
2. `complete`
   - 不再继续

这也是“虽然没有 tool_use，但系统仍可能继续一轮”的原因之一。

---

## 20. 第 16 阶段：直接完成 query

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2305)

如果：

- 没有 tool_use
- 没有恢复路径
- stop hook 没拦截
- token budget 没要求继续

那么本轮就：

- `emitQueryTerminated('completed')`
- `return { reason: 'completed' }`

这才意味着这条 query 生命周期真正结束。

注意：

**这不是“一轮结束”，而是“整条 query 结束”。**

---

## 21. 第 17 阶段：如果 assistant 产生了 tool_use，进入工具执行路径

如果 `needsFollowUp = true`，代码就不会走上面的直接完成路径，而会继续执行工具。

入口位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2311)

### 21.1 决定工具执行模式

发：

- `tool.execution.mode.selected`

然后选择：

- `streamingToolExecutor.getRemainingResults()`
  或
- `runTools(...)`

对应位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2330)
- [query.ts](/abs/path/E:/claude-code/src/query.ts:2344)

### 21.2 普通 `runTools(...)`

实现位置：

- [toolOrchestration.ts](/abs/path/E:/claude-code/src/services/tools/toolOrchestration.ts:21)

它会：

1. 按工具是否并发安全分 batch
2. 并发安全的工具并行跑
3. 非并发安全的工具串行跑
4. 产出 message update 和 context update

### 21.3 `StreamingToolExecutor`

实现位置：

- [StreamingToolExecutor.ts](/abs/path/E:/claude-code/src/services/tools/StreamingToolExecutor.ts:1)

它的作用是：

- assistant 还在流时，工具就可以边到边执行
- 但结果仍按工具收到的顺序被缓冲和产出

### 这一层的作用

把 assistant 的 tool_use blocks 变成真正的 tool_result，并更新上下文。

---

## 22. 第 18 阶段：工具结果后的附加处理

工具执行完之后，query loop 还会做几件事：

### 22.1 生成 tool summary

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2375)

这是为了把上一轮工具行为总结成更适合 UI 的摘要。

### 22.2 注入 attachment

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2550)

包括：

- queued commands
- memory prefetch 结果
- skill discovery prefetch 结果

### 22.3 刷新 tools

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2629)

例如新连上的 MCP tool 可以在下一轮可用。

### 22.4 任务摘要

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2651)

为后台 session/task 生成 summary。

### 22.5 maxTurns 检查

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2674)

---

## 23. 第 19 阶段：构造下一轮 `State`，继续 loop

位置：

- [query.ts](/abs/path/E:/claude-code/src/query.ts:2689)

本轮如果已经完成了工具执行，而且没有终止，就会构造：

- `next: State`

其中包括：

- `messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`
- `toolUseContext = updated context`
- `turnCount = nextTurnCount`
- `pendingToolUseSummary = nextPendingToolUseSummary`
- `transition = { reason: 'next_turn' }`

然后：

1. 发 `state.transitioned`
2. 发 `state.snapshot.after_turn`
3. `state = next`
4. `continue`

这就进入下一轮 turn。

### 实现思路

query loop 的核心思想不是递归，而是：

**在 while(true) 中不断构造下一轮完整状态，然后继续。**

这样所有 continuation path 都能统一落在 `State` 迁移模型里。

---

## 24. 那么，系统到底在哪些固定时机检查“要不要开子 agent / 旁路”？

总结一下，主要有三类时机。

### 24.1 post-sampling hooks

触发时机：

- 一轮模型响应结束后

典型：

- `session_memory`

调用链：

```text
queryLoop
-> executePostSamplingHooks
-> extractSessionMemory
-> shouldExtractMemory
-> runForkedAgent
-> 新的 session_memory query
```

### 24.2 stop hooks

触发时机：

- 一轮准备收尾时

典型：

- `prompt_suggestion`
- `extract_memories`
- `auto_dream`

调用链：

```text
queryLoop
-> handleStopHooks
-> executeExtractMemories / executePromptSuggestion / executeAutoDream
-> 各自 guard
-> runForkedAgent
```

### 24.3 显式命令 / 专用入口

典型：

- `/btw` 的 `side_question`
- compact 流程里的 `compact`

这类不是“主线程每轮都会检查一次”，而是只有进入对应功能路径时才会触发。

---

## 25. `session_memory` 为什么会在某些轮次后出现？

因为它的判断函数：

- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:135)

并不是每时每刻都跑，而是只在：

- 主线程某轮模型响应结束后
- 由 post-sampling hook 触发

它的核心判断条件是：

1. 初始化阈值是否达到
2. 自上次更新以来 token 增量是否达到
3. 是否满足：
   - tool call 数达到阈值，或
   - 最近一轮 assistant 已经没有 tool call，说明到了自然停顿点

所以 `session_memory` 的真实契机不是：

- “出现了某个神秘系统事件”

而是：

**“这一轮结束后，系统发现上下文已经积累到值得做一次后台会话记忆更新。”**

---

## 26. `session_memory` 到底维护什么

它维护的是当前会话的一份 markdown memory 文件。

关键位置：

- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:184)
- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:193)

它会：

1. 找 session memory 目录
2. 找 session memory 文件路径
3. 文件不存在就创建并写模板
4. 读当前内容
5. 构造更新 prompt
6. 起一个 forked agent 去更新这个文件

而且它的权限被收得很死：

- [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:469)

只允许对那一个 memory 文件执行 `Edit`。

---

## 27. 旁路和子 agent 的区别

不要把这两个词混为一谈。

### 子 agent

更具体：

- 通过 `runForkedAgent(...)` 启动
- 内部有自己的 `query()` loop
- 有自己独立的 `query_id / turn / tool`

### 旁路

更宽泛：

- 不走主线程正面继续路径
- 是一条“额外处理路径”

所以：

- 子 agent 是一种比较重的旁路
- 但旁路不一定都是子 agent

最典型的对比：

### `/btw` 的 `side_question`

位置：

- [sideQuestion.ts](/abs/path/E:/claude-code/src/utils/sideQuestion.ts:53)

它是 forked subagent：

- [sideQuestion.ts](/abs/path/E:/claude-code/src/utils/sideQuestion.ts:80)

### `sideQuery(...)`

位置：

- [sideQuery.ts](/abs/path/E:/claude-code/src/utils/sideQuery.ts:81)

它只是主线程外的一次轻量 API wrapper，**不等于 forked subagent**。

---

## 28. 一次用户动作为什么会变成多条 query

现在你可以把整个过程理解成一棵树：

```text
user_action
-> 主线程 query
   -> turn 1
   -> turn 2
   -> turn 3
   -> ...
   -> 某些时机触发 fork
      -> session_memory query
      -> extract_memories query
      -> side_question query
```

所以：

- 用户只发了一次请求
- 系统内部却可能开出多条 query
- 每条 query 自己又会有多轮 turn

这就是为什么必须用：

- `user_action_id` 看整棵树
- `query_id` 看某条分支

---

## 29. 最后给一个“最短但最正确”的总结

这套系统的主线程不是“一问一答函数”，而是一个**可持续推进的状态机**。

它每轮都做这几件事：

1. 读取当前状态
2. 预处理消息
3. 组 prompt
4. 调模型
5. 观察 assistant 是否提出 tool_use
6. 如有工具，执行工具并进入下一轮
7. 如无工具，检查恢复链 / stop hooks / token budget
8. 最终决定：
   - 继续下一轮
   - fork 出旁路 / 子 agent
   - 或终止整条 query

而所谓“子 agent”最本质的技术事实就是：

**某个模块在固定时机点判断条件成立后，调用 `runForkedAgent(...)`，于是系统又启动了一条新的 `query()` loop。**

---

## 30. 你接下来最应该怎么读源码

如果你以后要继续深入，建议按这个顺序：

1. [query.ts](/abs/path/E:/claude-code/src/query.ts:527)
   - 先读主线程状态机
2. [stopHooks.ts](/abs/path/E:/claude-code/src/query/stopHooks.ts:66)
   - 看一轮收尾时系统还会做什么
3. [forkedAgent.ts](/abs/path/E:/claude-code/src/utils/forkedAgent.ts:493)
   - 看 forked subagent 怎么启动自己的 query loop
4. [sessionMemory.ts](/abs/path/E:/claude-code/src/services/SessionMemory/sessionMemory.ts:135)
   - 看一个典型的“后台子 agent 触发条件”
5. [extractMemories.ts](/abs/path/E:/claude-code/src/services/extractMemories/extractMemories.ts:528)
   - 看一个典型的“stop hook 后台分支”
6. [toolOrchestration.ts](/abs/path/E:/claude-code/src/services/tools/toolOrchestration.ts:21)
   - 看工具执行是怎么接回下一轮的

这样读，你会从“一个 query loop 里面到底发生了什么”一路读到“为什么会长出多条分支 query”。
