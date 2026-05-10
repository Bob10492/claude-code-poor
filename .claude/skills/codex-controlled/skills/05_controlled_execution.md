---
title: 受控执行
type: reference
description: Use after user approval to execute one minimal closed-loop task. Integrates TDD, systematic debugging, parallel agents, and git worktrees as execution tools.
---

# Skill: 受控执行（Controlled Execution）

## 目标

在用户已经拍板后，Codex 只执行一个最小闭环任务，避免范围扩大和架构漂移。
执行层调用 superpowers 的技术 skill 来提升质量和效率。

---

## 执行前要求

必须已有：

- 明确任务书 / Spec Bundle
- 用户拍板
- 通过理解清单
- 通过 Preflight / Hygiene Gate
- 明确本轮不做什么
- 明确最小验证清单

---

## 执行原则

### 1. 一次只做一个最小闭环

例如：

- 只实现 bind_existing runner
- 只固化 experiment-run schema
- 只新增 score-spec 校验
- 只修 freshness
- 只补一个指标

不得顺手扩展。

---

### 2. 只改计划内文件

如果需要修改计划外文件，必须暂停说明：

```md
计划外修改需求：
为什么需要：
不改会怎样：
是否等待确认：
```

---

### 3. 不伪造能力

如果某能力尚无真实入口，不得假装实现。
应明确报错或留 scaffold。

---

### 4. 事实优先

正式结果必须能回溯到事实证据：

- run_id
- user_action_id
- observability_db_ref
- evidence_ref

无证据不得进入正式 score / compare / gate。

---

## Superpowers 技术 Skill 调用

根据当前任务类型，调用对应的 superpowers skill：

### 5.1 实现新功能或修 Bug → 调用 `test-driven-development`

在写实现代码之前，先写测试：

1. 分析要实现/修复的行为
2. 编写失败的测试用例
3. 运行测试确认失败
4. 写最小实现使测试通过
5. 运行全部测试确认无回归

**约束**：测试必须基于真实行为，不得 mock 纯函数或数据模块。

---

### 5.2 遇到 Bug / 测试失败 / 异常行为 → 调用 `systematic-debugging`

在提议修复之前，先系统诊断：

1. 收集症状（错误信息、堆栈、日志）
2. 缩小范围（二分法定位、最小复现）
3. 确认根因（读源码，不猜）
4. 用事实区分根因 vs 症状
5. 只有确认根因后才开始修复

**约束**：不得在未理解根因的情况下"试试看修"。

---

### 5.3 多个独立子任务 → 调用 `dispatching-parallel-agents`

当执行计划中有 2+ 个无依赖的子任务时：

1. 识别独立子任务
2. 为每个子任务创建清晰的 agent prompt
3. 并行派发给多个 agent
4. 汇总结果，处理冲突

**约束**：只有真正无共享状态的任务才能并行。

---

### 5.4 需要隔离的工作区 → 调用 `using-git-worktrees`

当任务需要：

- 与当前工作区隔离
- 避免污染正在进行的工作
- 在独立环境中执行计划

调用 `using-git-worktrees` 创建隔离工作区。

---

### 5.5 复杂多步骤任务 → 调用 `subagent-driven-development`

当任务涉及多个独立步骤且可以由子 agent 执行时：

1. 将计划中的独立步骤分配给子 agent
2. 子 agent 执行实现、代码审查、spec 审查
3. 主 agent 汇总结果并进行最终审查

---

## 决策树：选择哪种执行方式

```
收到执行计划
│
├─ 只有一个简单任务？
│  └─ 直接执行（test-driven-development）
│
├─ 有 bug / 测试失败？
│  └─ systematic-debugging → 确认根因 → test-driven-development
│
├─ 有 2+ 个独立子任务？
│  └─ dispatching-parallel-agents
│     └─ 每个子任务用 test-driven-development
│
├─ 任务复杂且步骤多？
│  └─ subagent-driven-development
│     └─ 子 agent 各自用 test-driven-development
│
└─ 需要隔离环境？
   └─ using-git-worktrees
      └─ 在 worktree 中执行上述任何方式
```

---

## 完成后输出

```md
## 执行完成摘要

### 修改文件
- ...

### 实现内容
- ...

### 使用的技术 Skill
- test-driven-development: [是/否]，测试数量: ...
- systematic-debugging: [是/否]，根因: ...
- dispatching-parallel-agents: [是/否]，并行任务数: ...
- using-git-worktrees: [是/否]
- subagent-driven-development: [是/否]

### 未完成项
- ...

### 风险
- ...

### 验证命令
- bun run typecheck
- bun test
- ...

### 最小验证清单
- [ ] ...
```

然后进入 Acceptance Review。
