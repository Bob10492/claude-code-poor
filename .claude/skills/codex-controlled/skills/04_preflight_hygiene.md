---
title: Project Hygiene Gate
type: reference
description: Use before implementation when project state, structure, generated files, truth sources, or observability/data integrity may affect the task.
---

# Skill: Project Hygiene Gate

## Purpose

Use before implementation when project state, structure, generated files, or the current truth source may be unclear.

This gate is broader than observability work.
It applies to normal engineering work when repository state or blast radius is uncertain.

## A. General Project Hygiene

Use before implementation when project state, structure, generated files, or current truth source may be unclear.

Check:

1. Working tree cleanliness
2. Project structure clarity
3. Process/generated file locations
4. Source of truth priority
5. Build/test/lint command availability
6. Blast radius
7. Need for git worktree isolation

### General Project Hygiene details

#### 1. Working tree cleanliness

- Are there unrelated local edits?
- Are generated files already present?
- Could current changes confuse the implementation or verification loop?

#### 2. Project structure clarity

- Which directory is the real implementation area?
- Which files are docs, generated outputs, fixtures, or artifacts?
- Which subprojects or packages are actually in play?

#### 3. Process/generated file locations

- Where do builds, reports, snapshots, caches, logs, and generated outputs land?
- Which paths should never be hand-edited?

#### 4. Source of truth priority

- What is the current authoritative source for this task?
- If docs, code, and runtime disagree, which source wins?

#### 5. Build/test/lint command availability

- What commands exist for verification?
- Which ones are authoritative for this area?
- Are there known gaps in the local verification setup?

#### 6. Blast radius

- Which files, packages, schemas, reports, or workflows could this task affect?
- Is the task still small enough for the chosen control level?

#### 7. Need for git worktree isolation

- Is the workspace dirty or risky enough to justify `using-git-worktrees`?
- Would isolation reduce cross-task contamination?

## B. Data / Observability Hygiene

Use additionally when the task involves logs, metrics, ETL, dashboard, runner, scorer, gate, schema, data cleaning, or experiments.

Check:

1. Data freshness
2. Data pollution
3. Reference closure
4. Schema compatibility
5. Impact analysis

### Data / Observability Hygiene details

#### 1. Data freshness

- Are the current event files up to date?
- Is the database stale?
- Are summaries or dashboards reading old outputs?
- Is a rebuild required before interpretation?

#### 2. Data pollution

- Are old logs mixed into the current dataset?
- Are old schema versions still present?
- Are prior runs, scores, or reports being reused incorrectly?
- Is cleanup or archival required?

#### 3. Reference closure

- Does `snapshot_ref` exist?
- Does `user_action_id` exist?
- Is each run tied to the required evidence?
- Does each score have an `evidence_ref`?
- Does each gate consume the expected score input?

#### 4. Schema compatibility

- Do manifest fields still match validators?
- Does the score spec exist?
- Does the gate policy exist?
- Are experiment references still valid?

#### 5. Impact analysis

- Which modules are affected?
- Which metrics are affected?
- Which reports or dashboards are affected?
- Which previous conclusions become less trustworthy?
- Could a local fix create a global inconsistency?

## Output Template

```md
## Project Hygiene Gate

### A. General Project Hygiene
- Working tree cleanliness:
- Project structure clarity:
- Process/generated file locations:
- Source of truth priority:
- Build/test/lint command availability:
- Blast radius:
- Need for git worktree isolation:
- Result: PASS / FAIL / CONDITIONAL

### B. Data / Observability Hygiene
- Applicable: yes / no
- Data freshness:
- Data pollution:
- Reference closure:
- Schema compatibility:
- Impact analysis:
- Result: PASS / FAIL / CONDITIONAL

### Gate Decision
- Proceed / Pause
- Required fixes before implementation:
```

## Hard Rules

- If General Project Hygiene fails, do not implement yet.
- If Data / Observability Hygiene applies and fails, do not implement yet.
- Level 3 work should not skip this gate.
