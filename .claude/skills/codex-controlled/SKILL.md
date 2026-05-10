---
name: codex-controlled
description: Use for controlled Codex collaboration workflows: requirement framing, discussion, layered explanation, preflight hygiene, controlled execution, acceptance review, and coaching checkpoints. Integrates superpowers technical skills at the execution layer.
---

# Skill: Codex 协作主控调度器（Master Orchestrator）

## 目标

本文件是项目内所有协作 skill 的**总调度器**。
它以 codex-controlled 的 Phase 流程为骨架，在执行层调用 superpowers 的技术 skill。

核心目标：

- 防止任务漂移
- 防止未经用户拍板自动推进
- 防止文档蓝图和当前代码真相混淆
- 防止用用户不懂的术语解释用户不懂的术语
- 让 Codex 既能执行，也能帮助用户逐步掌握验证、命令、排查、架构理解能力

---

## 最高原则

### 1. 当前代码与当前运行结果是真相

当同时存在：

- 当前源码
- 当前运行日志
- 当前数据库
- 当前观测结果
- PDF / 任务书 / 设计稿 / 历史总结 / 心得文档

默认优先级为：

1. 当前源码与当前运行结果
2. 当前日志 / 数据库 / 观测事实
3. 当前任务书
4. PDF / 上游分析 / 历史总结 / 心得

不得默认文档与当前项目完全一致。

---

### 2. 用户理解优先于执行速度

如果用户还不能理解：

- 本轮目标
- 思路来源
- 设计选择
- 约束条件
- 架构设计点
- 风险
- 验收口径

则不得进入写代码 / 写文件 / 自动推进下一 phase。

---

### 3. Checkpoint 是唯一推进闸门

每个 phase 结束后，必须等待用户拍板。
未经用户明确批准，不得：

- 自动进入下一 phase
- 顺手补 unrelated 功能
- 从"能跑"扩展成"全系统完成"
- 用"建议继续"替代"等待确认"

---

### 4. 事实 / 推断 / 不确定点必须分离

输出必须区分：

- 【事实】来自源码、日志、文档原文、当前运行结果
- 【推断】基于调用链、命名、行为的合理判断
- 【不确定点】需要用户确认或进一步查看源码

不得把推断包装成事实。

---

## 模式选择

收到任务后，先判断当前进入哪种模式。

| 模式 | 何时使用 | 调用子 skill | Superpowers 增强 |
|---|---|---|---|
| Framing / 定格 | 需求混乱、不确定本轮边界 | `01_requirement_framing.md` | `brainstorming` |
| Discussion / 讨论 | 用户和 agent 对方案理解不一致 | `02_discussion_mode.md` | — |
| Explanation / 分层解释 | 用户看不懂术语、代码结构 | `03_layered_explanation.md` | — |
| Preflight / 卫生检查 | 涉及日志、ETL、指标、数据、实验 | `04_preflight_hygiene.md` | — （superpowers 无此能力） |
| Execution / 受控执行 | 已拍板，可以写代码 | `05_controlled_execution.md` | `test-driven-development`、`systematic-debugging`、`dispatching-parallel-agents`、`using-git-worktrees`、`subagent-driven-development` |
| Review / 验收复盘 | 需自查、验收、checkpoint | `06_acceptance_review.md` | `verification-before-completion`、`requesting-code-review` |
| Coaching / 教练式学习 | 用户希望掌握能力 | `07_coach_mode.md` | — （superpowers 无此能力） |

---

## 默认 Phase 流程

### Phase 0：问题定格

输出：

- 本轮目标
- 真实约束
- 输入材料
- 输出形式
- 冲突处理要求
- 本轮不做
- 应进入哪种模式

**Superpowers 增强**：如果需求模糊、涉及新功能设计，调用 `brainstorming` skill。brainstorming 的设计流程（澄清→方案→spec 文档）与本 Phase 的定格流程互补。

禁止写代码。

---

### Phase 1：理解与讨论

如果用户不能完全理解方案，进入 Discussion 或 Explanation 模式。

目标不是"说服用户"，而是双方把概念、约束、分歧、方案、风险、验收口径说清楚。

未通过不得进入执行。

---

### Phase 2：Spec Bundle

如果已经明确要执行，输出统一 Spec Bundle：

- 背景解读
- 强制要求
- 验收标准
- 冲突处理规则
- Checkpoint 规则
- 本轮不做

**Superpowers 增强**：如果来自 brainstorming，其产出的设计文档即为 Spec Bundle 的输入。设计文档保存到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`。

---

### Phase 3：Preflight / Hygiene Gate

任何涉及以下内容的任务必须先做卫生检查：

- 日志、指标、ETL、dashboard、runner、scorer、gate、数据清洗、schema、实验平台

Preflight 未通过，禁止实现。

**说明**：superpowers 没有对应能力。这是 codex-controlled 的独有价值，保留不动。

---

### Phase 4：Execution Plan

输出：

- 修改哪些文件
- 不修改哪些文件
- 本轮最小闭环
- 修改顺序
- 验证顺序
- 风险点
- 失败时停下条件

**Superpowers 增强**：调用 `writing-plans` skill。将本 Phase 的输出约束（最小闭环、风险点、停下条件）注入 writing-plans 的计划模板中。

---

### Phase 5：Controlled Execution

一次只做一个最小闭环任务。
禁止顺手扩展。

**Superpowers 增强**：这是整合最密集的 Phase。根据任务类型调用对应的 superpowers 技术 skill：

| 任务类型 | 调用的 superpowers skill | 说明 |
|---|---|---|
| 实现新功能/bugfix | `test-driven-development` | 先写测试，再写实现 |
| 遇到 bug/测试失败 | `systematic-debugging` | 系统化诊断根因，不急着修 |
| 多个独立子任务 | `dispatching-parallel-agents` | 并行派发给多个 agent |
| 需要隔离的工作区 | `using-git-worktrees` | 创建 git worktree 隔离开发 |
| 复杂多步骤任务 | `subagent-driven-development` | 派生子 agent 执行和审查 |

执行过程始终受以下约束：

- 一次只做一个最小闭环
- 只改计划内文件
- 不伪造能力
- 事实优先

---

### Phase 6：Self-check

完成后输出：

- 修改摘要
- 自查结果
- 未通过项
- 风险项
- 严格口径 / 推断口径
- 最小验证清单

**Superpowers 增强**：调用 `verification-before-completion` skill。在声称完成之前，必须运行验证命令（如 `bun run typecheck`、`bun test`）并展示实际输出。没有证据不得声称完成。

---

### Phase 7：Human Review

等待用户拍板。
没有用户批准，不得自动继续。

**Superpowers 增强**：

- 调用 `requesting-code-review` skill 进行最终审查
- 输出 Checkpoint 卡片（见 `06_acceptance_review.md`）
- 如果用户需要学习验证能力，进入 Coach Mode（`07_coach_mode.md`）

---

### Phase 8：收尾

**Superpowers 增强**：调用 `finishing-a-development-branch` skill，引导用户选择：

- 直接合并到当前分支
- 创建 PR
- 保留分支待后续
- 清理并丢弃

---

## 冲突处理模板

如果发现文档与当前项目冲突，必须暂停：

```md
冲突点：
文档中的描述：
当前项目中的实际情况：
我的判断：
候选处理方案 A：
候选处理方案 B：
我暂停在这里等待确认：
```

---

## 最短提问模板

用户可用以下格式发起任务：

```md
本轮目标：
真实约束：
输入材料：
输出形式：
冲突处理要求：
本轮不做：
是否先做理解清单：
是否需要 Preflight / Hygiene Gate：
我希望你用 Level 几的教练式辅助：
```

---

## 子 skill 调用规则

### 原有规则（保留）

- 如果用户说"我没理解"，优先调用 `02_discussion_mode.md` 或 `03_layered_explanation.md`
- 如果用户说"请执行"，但尚未经过理解清单，必须先回到理解阶段
- 如果任务涉及数据/日志/指标/实验，必须调用 `04_preflight_hygiene.md`
- 如果已经写代码，必须调用 `06_acceptance_review.md`
- 如果涉及命令或验证，必须调用 `07_coach_mode.md`

### Superpowers 调用规则（新增）

- 如果任务是新功能设计，Phase 0 中调用 `brainstorming`
- 如果需要执行计划，Phase 4 中调用 `writing-plans`
- 如果实现功能/修 bug，Phase 5 中调用 `test-driven-development`
- 如果遇到 bug/异常行为，Phase 5 中调用 `systematic-debugging`
- 如果有多个独立子任务，Phase 5 中调用 `dispatching-parallel-agents`
- 如果需要隔离环境，Phase 5 中调用 `using-git-worktrees`
- 如果任务复杂且步骤多，Phase 5 中调用 `subagent-driven-development`
- Phase 6 中必须调用 `verification-before-completion`
- Phase 7 中调用 `requesting-code-review`
- Phase 8 中调用 `finishing-a-development-branch`

---

## Superpowers 技术 Skill 速查

| Skill | 触发条件 | 调用方式 |
|---|---|---|
| `brainstorming` | 新功能设计，需求不明确 | 自然语言触发或 `/brainstorming` |
| `writing-plans` | 有 spec/需求，需要执行计划 | 自然语言触发或 `/writing-plans` |
| `test-driven-development` | 实现功能/修 bug 前 | 自然语言触发或 `/test-driven-development` |
| `systematic-debugging` | 遇到 bug/测试失败 | 自然语言触发或 `/systematic-debugging` |
| `dispatching-parallel-agents` | 2+ 独立子任务 | 自然语言触发或 `/dispatching-parallel-agents` |
| `using-git-worktrees` | 需要隔离工作区 | 自然语言触发或 `/using-git-worktrees` |
| `subagent-driven-development` | 复杂多步骤任务 | 自然语言触发或 `/subagent-driven-development` |
| `verification-before-completion` | 声称完成前 | 自然语言触发或 `/verification-before-completion` |
| `requesting-code-review` | 完成任务/合并前 | 自然语言触发或 `/requesting-code-review` |
| `finishing-a-development-branch` | 实现完成，测试通过 | 自然语言触发或 `/finishing-a-development-branch` |
