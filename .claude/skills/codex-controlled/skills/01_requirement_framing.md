---
title: 需求定格与任务收敛
type: reference
description: Use when a task boundary is unclear and the request must be compressed into goals, constraints, inputs, outputs, non-goals, and a recommended execution mode. Integrates brainstorming for design-intensive tasks.
---

# Skill: 需求定格与任务收敛（Requirement Framing）

## 目标

当用户需求较散、约束不完整、阶段不明确时，先把任务收敛到可执行范围。

---

## 判断：定格 vs 设计

收到需求后，先判断任务类型：

| 任务类型 | 特征 | 处理方式 |
|---|---|---|
| **明确定格** | 需求清晰，只是边界/约束需要澄清 | 直接进入定格流程 |
| **设计探索** | 需求模糊，涉及新功能/架构/组件设计 | 调用 `brainstorming` skill |

### 何时调用 brainstorming

以下情况应调用 `brainstorming`：

- 用户说"我想做一个..."（新功能）
- 需求涉及架构决策（用哪种方案、如何拆分）
- 需要交互式探索才能明确要做什么
- 涉及 UI/UX 设计
- 涉及可视化问题

调用 brainstorming 后，其产出的设计文档即为 Spec Bundle 的输入。

### 何时直接定格

以下情况直接进入定格流程：

- 用户需求明确，只是需要澄清约束
- bugfix / 测试补充 / 文档更新
- 小范围重构
- 配置调整

---

## 输出模板

```md
## 需求压缩

### 本轮目标
...

### 真实约束
...

### 输入材料
...

### 输出形式
...

### 冲突处理要求
...

### 本轮不做
...

### 推荐进入的模式
- Discussion / Explanation / Preflight / Execution / Review / Coach
```

---

## 高价值信息识别

主动指出：

- 哪些信息决定任务方向
- 哪些内容重复
- 哪些内容展开过早
- 哪些内容与当前阶段无关

---

## 本轮边界

必须明确：

- 做什么
- 不做什么
- 谁拍板
- 何时停下
