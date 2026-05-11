---
title: Superpowers Routing and Conflict Policy
type: reference
description: Use to decide which Superpowers skill may be called in which phase, and which codex-controlled constraints remain non-bypassable.
---

# Skill: Superpowers Routing and Conflict Policy

## Control Plane vs Execution Layer

`codex-controlled` is the control plane.
Superpowers is the execution capability layer.

The control plane decides whether execution may proceed.
The execution layer decides how approved work is performed.

## Superpowers Routing Matrix

| Phase | Trigger | Superpowers skill | codex-controlled constraint |
|---|---|---|---|
| Phase 0 Framing | New feature, architecture, UI/UX, visualization, unclear design | brainstorming | Output is only design input, not execution permission |
| Phase 4 Planning | Spec Bundle exists and user wants implementation | writing-plans | Plan must include non-goals, file boundaries, minimal loop, stop conditions |
| Phase 5 Execution | New feature or bugfix | test-driven-development | Only within approved scope |
| Phase 5 Debugging | Bug, failing test, abnormal behavior | systematic-debugging | No fix before root cause evidence |
| Phase 5 Parallel | 2+ independent subtasks | dispatching-parallel-agents | Only if tasks have no shared mutable state |
| Phase 5 Isolation | Dirty/risky workspace | using-git-worktrees | Worktree does not remove checkpoint requirements |
| Phase 5 Complex | Multi-step implementation | subagent-driven-development | Main agent remains responsible for scope and final review |
| Phase 6 Verification | Before claiming completion | verification-before-completion | No real output means no completion claim |
| Phase 7 Review | Before merge/PR or final acceptance | requesting-code-review | Review result feeds checkpoint |
| Phase 8 Finishing | After verified completion | finishing-a-development-branch | No auto-merge or cleanup without user choice |

## Supporting Superpowers mappings

| Context | Superpowers skill | codex-controlled constraint |
|---|---|---|
| Phase 5 plan-following execution | executing-plans | Execution order does not expand approved scope, file boundaries, or stop conditions |
| Phase 7 review feedback intake | receiving-code-review | Review feedback is input, not automatic permission for new changes |
| Cross-phase skill selection help | using-superpowers | Meta-guidance does not bypass control levels, hygiene gates, checkpoints, or evidence rules |

## Conflict Priority

When `codex-controlled` and Superpowers rules overlap or conflict:

1. User explicit instruction wins.
2. Safety, truthfulness, and current runtime evidence win.
3. `codex-controlled` checkpoints win.
4. Project Hygiene Gate wins before implementation.
5. Data / Observability Hygiene wins for logs, metrics, ETL, dashboard, runner, scorer, gate, schema, experiment tasks.
6. Superpowers decides methodology only inside approved execution boundaries.
7. Speed and completeness never override user understanding.

## Execution Suspension Rules

Suspend planning or execution-oriented Superpowers skills when:

- The user says they do not understand.
- The user disputes the framing or decision logic.
- The user asks why a method, architecture, or file boundary was selected.
- The current truth source is unclear.
- The Project Hygiene Gate has not passed.

Resume only after the decision points are understood and the current checkpoint permits execution.
