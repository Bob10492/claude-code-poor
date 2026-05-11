---
title: Acceptance Review and Checkpoint
type: reference
description: Use after implementation to verify completion with evidence, incorporate code review, and produce the checkpoint card before any next phase.
---

# Skill: Acceptance Review and Checkpoint

## Purpose

Acceptance Review decides whether the current loop is actually complete.

`verification-before-completion` provides evidence.
`requesting-code-review` provides review.
The checkpoint card is still owned by `codex-controlled`.

## Inputs

- Changed files
- Intended goal
- Verification commands and their real outputs
- Review findings if review was requested
- Known gaps
- Remaining risks

## Step 1: Verification evidence

Run `verification-before-completion` before any completion claim.

Rules:

- No real output means no completion claim.
- A failed required check means the loop is not complete.
- A guessed pass is still a fail.

## Step 2: Goal and scope review

Check:

- Did the work satisfy the stated goal?
- Did the implementation stay inside approved scope?
- Did any unapproved file changes happen?
- Did the work create new unexplained risk?

## Step 3: Review input

Use `requesting-code-review` when the task benefits from explicit review.
Use `receiving-code-review` when review feedback arrives and must be interpreted without silently expanding scope.

Review informs the checkpoint.
Review does not replace the checkpoint.

## Step 4: Checkpoint card

Produce a checkpoint card that includes:

- Goal
- Actual completion
- Files changed
- Verification evidence
- Review result
- Remaining gaps
- Remaining risks
- Whether user approval is required before the next phase

## Hard Rules

- No checkpoint means the task is not complete.
- No user approval means do not continue.
- No real verification output means do not claim completion.
- If verification fails, return to Controlled Execution.

## Checkpoint Template

```md
## Checkpoint

### Goal
...

### Actual Completion
...

### Files Changed
...

### Verification Evidence
- command:
- output summary:
- pass/fail:

### Review Result
...

### Remaining Gaps
...

### Remaining Risks
...

### Decision
- Complete for this checkpoint: yes / no
- Waiting for user approval: yes / no
```
