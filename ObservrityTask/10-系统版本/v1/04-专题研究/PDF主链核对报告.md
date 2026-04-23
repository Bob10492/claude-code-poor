# PDF 主链核对报告

本文是基于当前源码的第一版主链核对报告。

核对原则：

- 以当前项目源码为实现真相
- 以 PDF/任务书为理论蓝图与检查清单
- 对无法从当前源码证明的能力标为 `uncertain`
- 对存在但被 gate / stub / no-op 处理的节点标为 `disabled` 或 `rewritten`

状态含义：

- `present`：存在且主语义仍然成立
- `disabled`：代码在，但默认不生效或被 gate/stub 封住
- `rewritten`：入口仍在，但内部语义已和蓝图有明显差异
- `deleted`：当前源码中找不到
- `uncertain`：需要更多 PDF 正文证据或运行证据确认

---

## 核对表

| PDF 节点 | 当前文件 / 位置 | 当前状态 | 证据 | 处理建议 |
| --- | --- | --- | --- | --- |
| `QueryEngine.submitMessage` | `src/QueryEngine.ts` | `present` | `QueryEngine` 持有会话级状态；`submitMessage()` 负责输入处理、写 transcript、触发 `query()` | 作为非交互/SDK 提交主入口接入统一埋点 |
| `processUserInput` | `src/utils/processUserInput/processUserInput.ts` | `present` | 负责 slash command、附件、图片、文本 prompt 归一化 | 已接入输入层埋点 |
| `query` | `src/query.ts` | `present` | `query()` 为导出的 AsyncGenerator，委托给 `queryLoop()` | 作为 query 生命周期起点接入 |
| `queryLoop` | `src/query.ts` | `present` | `while(true)` 主循环，维护 `State` 并处理 request/tool/recovery | 作为核心主编排器埋点主战场 |
| `State` | `src/query.ts` | `present` | 本地 `type State` 持有 messages、toolUseContext、turnCount、transition 等 | 已补 state snapshot/transition 埋点 |
| `getMessagesAfterCompactBoundary` | `src/utils/messages.ts` | `present` | 按 compact boundary 切片，并在 `HISTORY_SNIP` 下投影 snipped view | 已接入预处理链埋点 |
| `applyToolResultBudget` | `src/utils/toolResultStorage.ts` | `present` | 对过大 tool_result 做持久化/替换，query loop 中显式调用 | 已接入预处理链埋点 |
| `HISTORY_SNIP` | `src/query.ts` + `src/utils/messages.ts` | `present` | `feature('HISTORY_SNIP')` 下执行 `snipCompactIfNeeded()` 与 snip 投影 | 属于 feature-gated present，需要在报告中明确受 gate 控制 |
| `microcompact` | `src/services/compact/microCompact.ts` | `present` | query loop 中通过 `deps.microcompact()` 调用 | 已接入预处理链埋点 |
| `contextCollapse` | `src/services/contextCollapse/index.ts` | `disabled` | 当前文件为自动生成 stub；`isContextCollapseEnabled()` 硬编码返回 `false` | 视为已定义但默认关闭，不应按 PDF 的完整能力强套 |
| `autocompact` | `src/services/compact/autoCompact.ts` | `present` | `autoCompactIfNeeded()`、阈值判断、circuit breaker、querySource 保护均存在 | 已接入 checked/completed 埋点 |
| `callModel` | `src/query.ts` + `src/services/api/claude.ts` | `present` | `deps.callModel()` 驱动流式 API 调用，query loop 中处理 yielded message | 已接入 request/build/stream 事件 |
| `StreamingToolExecutor` | `src/services/tools/StreamingToolExecutor.ts` | `present` | 流式期间并发执行工具，支持 queued/executing/completed/yielded | 已接入 mode 选择；后续继续补 streaming executor 内部更细颗粒事件 |
| `runTools` | `src/services/tools/toolOrchestration.ts` | `present` | 串/并行分批执行工具，支持 context modifier 合并 | 已接入 batch/mode/context 事件 |
| `handleStopHooks` | `src/query/stopHooks.ts` | `present` | 主线程/子 agent 结束后执行 stop hooks、teammate hooks、background bookkeeping | 已接入 started/completed 事件 |
| prompt-too-long recover | `src/query.ts` | `present` | 先尝试 collapse drain，再尝试 reactive compact，最后才终止 | 需要继续细化专门 recovery 事件 |
| max_output_tokens recover | `src/query.ts` | `present` | 先 8k→64k 提升，再 meta-message 续写恢复，带次数上限 | 需要继续细化专门 recovery 事件 |
| token budget continuation | `src/query.ts` + `src/query/tokenBudget.ts` | `present` | 达阈值后可注入 nudge message 继续下一轮 | 已接入 `token_budget.decision` |
| subagent 触发链 | `src/utils/forkedAgent.ts` + `extractMemories` + `SessionMemory` + `awaySummary` | `present` | forked agent 基础设施存在；`extract_memories`、`session_memory`、`away_summary` 均有真实调用点 | 已接入子 agent 生命周期基础事件 |

---

## 重点发现

### 1. 主链与任务书描述总体一致

当前代码确实存在：

- 提交层
- 输入归一化
- `query/queryLoop`
- 预处理链
- API 流式调用
- 工具调度
- 恢复链
- stop hooks
- subagent/forked agent

这意味着任务书所要求的统一埋点体系可以直接落在真实运行链路上，而不是靠推测拼装。

### 2. `contextCollapse` 不是“完整实现”，而是明确 stub

这是当前最需要持续警惕的节点。

证据：

- `src/services/contextCollapse/index.ts`
- `isContextCollapseEnabled()` 返回 `false`
- `applyCollapsesIfNeeded()` 返回原消息
- `recoverFromOverflow()` 返回 `committed: 0`

因此这个节点应标为 `disabled`，不能假设 PDF 中描述的 collapse 语义在当前项目里真实生效。

### 3. `HISTORY_SNIP` 仍然存在，但受 gate 控制

这类节点不是 `deleted`，也不是完全 `rewritten`，更准确的是：

- 结构存在
- 代码路径存在
- 是否实际生效取决于 feature gate / build 形态

### 4. subagent 链路是真实能力，不是伪实现

当前源码可以证明：

- `runForkedAgent()` 真的调用 `query()`
- 会积累 usage
- 可写 sidechain transcript
- `extract_memories` / `session_memory` 会以 forked 模式发起自己的 prompt 与工具调用

这部分必须纳入统一观测模型。

---

## 当前处理建议

### 立即按真实链路埋点

优先级最高的真实链路：

1. `submitMessage`
2. `processUserInput`
3. `query/queryLoop`
4. preprocess
5. prompt build
6. API streaming
7. tools
8. stop hooks
9. subagent
10. termination

### 对 stub / gate 节点做显式状态化

不要删定义，要明确标注：

- `disabled`
- `present_but_gated`
- `rewritten`

### 后续继续补证据

本报告仍需补强：

- PDF 正文页级证据
- 运行时样例日志
- `StreamingToolExecutor` 内部更细粒度状态
- recovery 专项事件与状态说明

---

## 当前结论

就当前源码而言：

- 主编排器、工具调度器、恢复链、forked subagent 都真实存在
- `contextCollapse` 当前是 disabled/stub
- `HISTORY_SNIP`、`autocompact`、`microcompact`、`toolResultBudget` 都存在
- 统一埋点应围绕当前真实主链实现，而不是把 PDF 描述硬覆盖到所有节点
