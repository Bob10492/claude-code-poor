---
title: Discussion Mode
type: reference
description: Use when the user and Codex need to align on project understanding, tradeoffs, terminology, risks, and decision points before planning or implementation.
---

# Skill: Discussion Mode

## Purpose

Discussion Mode aligns understanding before execution.
It is not a slower form of execution.
It is a pause that protects correctness, boundaries, and user agency.

## Trigger Conditions

Use this mode when:

- The user says they do not understand.
- The user disagrees with the proposed plan or architecture.
- The user asks why a decision was made.
- The task has competing solution paths and the tradeoffs matter.
- The current truth source is disputed or unclear.

## Execution Suspension Rule

If the user expresses confusion, disagreement, or asks why, suspend execution-oriented Superpowers skills.
Do not continue planning or execution until the user understands the key decision points.

This suspension includes, when active:

- `writing-plans`
- `test-driven-development`
- `systematic-debugging`
- `dispatching-parallel-agents`
- `using-git-worktrees`
- `subagent-driven-development`

## Discussion Outputs

### Problem statement

Summarize the real decision in one short paragraph.

### Alignment map

```md
What the user appears to want:
...

What the current repository/runtime suggests:
...

Where the mismatch is:
...
```

### Terms and tradeoffs

| Item | Plain explanation | Why it matters here |
|---|---|---|
| Term / option | ... | ... |

### Decision points

```md
Decision A:
- Option 1:
- Option 2:
- Recommended choice:
- Reason:
```

## Prohibited Behavior

Do not:

- Write code
- Edit files
- Present a design conclusion as already approved
- Use jargon to avoid explanation
- Continue into execution because the answer seems "probably fine"

## Exit Criteria

Leave Discussion Mode only when the user can reasonably understand:

- The key decision points
- The tradeoffs
- The risks
- What approval they are giving
