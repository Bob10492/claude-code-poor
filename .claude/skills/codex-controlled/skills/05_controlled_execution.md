---
title: Controlled Execution
type: reference
description: Use after approval to execute one approved minimal closed loop while Superpowers skills provide the engineering method inside fixed boundaries.
---

# Skill: Controlled Execution

## Purpose

Controlled Execution is where approved work happens.
Superpowers skills may perform the engineering method, but Controlled Execution defines:

- approved scope
- allowed files
- forbidden files
- minimum closed loop
- stop conditions
- evidence requirements

## Preconditions

Before implementation, confirm:

- The task has a frame or Spec Bundle.
- The current control level is known.
- The user has approved the current step when approval is required.
- The Project Hygiene Gate has passed when applicable.
- The verification target is known.

## Core Rules

### One minimal closed loop at a time

Do one bounded loop, not a broad sweep.

Examples:

- one bugfix
- one test addition
- one schema fix
- one runner wiring change
- one dashboard correction

### Only change planned files

If an unplanned file becomes necessary, pause and surface it.

Use this template:

```md
Unplanned file change required:
- Why it is needed:
- Risk if not changed:
- Is approval required before continuing:
```

### Do not fake capabilities

If a real integration, artifact, or interface does not exist, do not pretend it does.
Use an explicit error, stub, scaffold, or follow-up note instead.

### Facts first

Tie claims back to real code, runtime behavior, command output, logs, reports, or artifacts.

## Superpowers inside Controlled Execution

Superpowers skills may perform the engineering method, but they do not expand scope.

Any plan-following helper such as `executing-plans` stays subordinate to approved scope, allowed files, forbidden files, minimum closed loop, and stop conditions.

### `test-driven-development`

Use for approved feature or bugfix work.

Constraint:

- Only inside approved scope.
- Tests must reflect real behavior.

### `systematic-debugging`

Use for bugs, failing tests, or abnormal behavior.

Constraint:

- No fix before root cause evidence.
- Do not guess-repair.

### `dispatching-parallel-agents`

Use only for 2 or more independent subtasks.

Constraint:

- No shared mutable state between subtasks.
- Main agent still owns integration and final review.

### `using-git-worktrees`

Use when workspace isolation is necessary.

Constraint:

- Worktree isolation does not remove checkpoint requirements.

### `subagent-driven-development`

Use for multi-step work with cleanly separable subtasks.

Constraint:

- Main agent remains responsible for scope, final quality bar, and final review.

## Stop Conditions

Pause execution when:

- The task crosses approved scope.
- A forbidden file becomes necessary.
- The root cause is still unclear.
- The hygiene gate assumptions were wrong.
- The verification target becomes unavailable.
- User understanding has fallen behind the current decision.

## Output Template

```md
## Controlled Execution Summary

### Approved Scope
...

### Allowed Files
...

### Forbidden Files
...

### Minimum Closed Loop
...

### Evidence Requirements
...

### Superpowers Method Used
...

### Remaining Risks
...
```
