---
title: Requirement Framing
type: reference
description: Use when a task boundary is unclear and the request must be compressed into goals, constraints, inputs, outputs, non-goals, and a recommended control level.
---

# Skill: Requirement Framing

## Purpose

Requirement Framing compresses scope.
It turns a loose request into a bounded task that can later be planned, executed, reviewed, or paused.

## What this phase owns

- Goal compression
- Boundary compression
- Constraint capture
- Input and output definition
- Non-goals
- Recommended control level
- Whether Project Hygiene Gate is needed
- Whether brainstorming is needed

## Requirement Framing vs Brainstorming

Requirement Framing is a control-plane activity.
`brainstorming` is only for design exploration.

Use `brainstorming` when the task includes unclear design, architecture choice, UI/UX direction, visualization design, or multiple plausible solution shapes.

Rules:

1. `brainstorming` output is design exploration, not execution permission.
2. `brainstorming` output must flow back into the Spec Bundle.
3. `brainstorming` must not directly trigger code execution.
4. If the task becomes clear without brainstorming, stay in Requirement Framing.

## Output Template

```md
## Requirement Frame

### Goal
...

### Constraints
...

### Inputs
...

### Expected Output
...

### Non-goals
...

### Scope Boundary
...

### Recommended Control Level
Level 0 / Level 1 / Level 2 / Level 3

### Need Project Hygiene Gate
yes / no / conditional

### Need Brainstorming
yes / no

### Recommended Next Phase
Discussion / Layered Explanation / Project Hygiene Gate / Planning / Controlled Execution
```

## High-value framing questions

- What is the smallest version of this task that still satisfies the goal?
- Which files, systems, or domains are inside scope?
- Which nearby concerns are explicitly out of scope?
- What must be true before implementation is allowed?
- What evidence will later count as completion?

## Exit Criteria

Do not leave Requirement Framing until the task has:

- A clear goal
- A clear boundary
- Explicit non-goals
- A proposed control level
- A clear next phase
