---
title: 验收与 Checkpoint Review
type: reference
description: Use after implementation to verify completion with evidence, review goal fit, and checkpoint before any next phase. Integrates verification-before-completion and requesting-code-review.
---

# Skill: 验收与 Checkpoint Review

## 目标

在 Codex 完成一轮实现后，不直接继续，而是：

1. 运行验证命令并展示输出（evidence before assertions）
2. 审查是否完成本轮目标、是否产生漂移、是否证据充分
3. 等待用户拍板

---

## 验收输入

- 修改文件列表
- 自查结果
- 运行命令及实际输出
- 输出 artifacts
- errors/warnings
- run/report/score/gate 结果
- 未完成项
- 风险项

---

## Step 1：验证（调用 `verification-before-completion`）

在声称完成之前，必须运行验证命令并展示实际输出。

### 必跑验证命令

```md
## 验证结果

### 类型检查
命令：bun run typecheck
结果：[粘贴实际输出]
状态：[PASS / FAIL]

### 测试
命令：bun test [相关测试文件]
结果：[粘贴实际输出]
状态：[PASS / FAIL]

### Lint（如果修改了源码）
命令：bun run lint
结果：[粘贴实际输出]
状态：[PASS / FAIL]

### 其他验证
- [列出其他相关验证命令及其输出]
```

### 硬规则

- **没有实际命令输出，不得声称任何测试通过**
- **任何测试失败，不得声称完成**
- **类型检查失败，不得继续**
- **如果验证失败，回到 Phase 5 修复**

---

## Step 2：审查（原有验收维度）

### 2.1 目标匹配

- 本轮目标是否完成
- 是否做了本轮不做的事情
- 是否出现 scope creep

### 2.2 证据充分

- 是否有运行命令
- 是否有输出文件
- 是否有 report
- 是否有 evidence_ref
- 是否有 errors/warnings 说明

### 2.3 事实优先

- 是否基于真实数据
- 是否使用了推断口径
- 推断是否明确标注

### 2.4 风险暴露

- 未完成项是否说清
- 风险是否可接受
- 是否需要用户拍板

---

## Step 3：代码审查（调用 `requesting-code-review`）

在验证通过后，进行最终代码审查：

### 审查清单

```md
## 代码审查

### 功能正确性
- [ ] 实现符合 spec/需求
- [ ] 边界情况已处理
- [ ] 错误处理合理

### 代码质量
- [ ] 无 `as any`（生产代码）
- [ ] 无未使用的变量/导入
- [ ] 命名清晰一致
- [ ] 函数职责单一

### 测试覆盖
- [ ] 新增功能有测试
- [ ] bugfix 有回归测试
- [ ] 测试覆盖关键路径

### 安全性
- [ ] 无命令注入
- [ ] 无 XSS / SQL 注入
- [ ] 敏感信息未暴露

### 项目规范
- [ ] 遵循 Conventional Commits
- [ ] tsc 零错误
- [ ] bun test 全绿
```

---

## Step 4：Checkpoint 卡片

```md
## Checkpoint

### 本轮目标
...

### 实际完成
...

### 修改文件
...

### 验证结果
- typecheck: [PASS/FAIL]
- tests: [PASS/FAIL] (N tests in M files)
- lint: [PASS/FAIL]

### 代码审查结果
- 功能正确性: [PASS/FAIL]
- 代码质量: [PASS/FAIL]
- 测试覆盖: [PASS/FAIL]
- 安全性: [PASS/FAIL]
- 项目规范: [PASS/FAIL]

### 未完成项
...

### 风险项
...

### 是否满足验收
- [ ] 所有验证命令通过
- [ ] 代码审查通过
- [ ] 无 scope creep
- [ ] 事实/推断已分离

### 下一步候选 A
...

### 下一步候选 B
...

### 是否等待用户拍板
是
```

---

## 硬规则

- 没有实际验证输出，不算完成
- 没有 checkpoint，不算完成
- 用户未拍板，不得继续
- 如果 Codex 想自动进入下一 phase，判定为执行意图漂移
