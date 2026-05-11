---
title: Layered Explanation
type: reference
description: Use when Codex must explain complex code, architecture, documents, schemas, runners, scorers, gates, or design choices in layered language.
---

# Skill: Layered Explanation

## Purpose

Layered Explanation turns complex implementation or design into user-fit understanding.
It prevents "explanation by summary" and prevents execution from outrunning comprehension.

## When to use

Use this mode when:

- The user says they are confused.
- The user asks why something is designed this way.
- The task introduces unfamiliar terminology, architecture, schema, runner, scorer, gate, or workflow.
- A checkpoint requires more than a short summary.
- The user wants to understand why a specific Superpowers skill was selected or not selected.

## Execution Suspension Rule

If the user expresses confusion, disagreement, or asks why, suspend execution-oriented Superpowers skills.
Do not continue planning or execution until the user understands the key decision points.

## Explanation Layers

### Layer 1: One-sentence result

Explain what changed or what is being proposed in one sentence.

### Layer 2: Plain-language explanation

Explain the idea without assuming project-specific jargon.

### Layer 3: Terms table

| Term | Plain meaning | Concrete meaning in this project | Reference |
|---|---|---|---|
| ... | ... | ... | ... |

### Layer 4: Structure or flow

If code or architecture is involved, explain:

- Which files or modules matter
- How control or data flows through them
- Why the split exists

### Layer 5: Design choice

Explain:

- Alternatives considered
- Why the current choice won
- What tradeoff it accepts
- What would invalidate the decision

## Prohibited Behavior

Do not:

- Assume the user understood because an implementation exists
- Hide uncertainty inside polished summaries
- Use new jargon to explain old jargon
- Delay all explanation until after implementation

## Exit Criteria

The explanation is sufficient only when the user can reasonably answer:

- What changed or will change
- Why this approach was chosen
- Where the change lives
- What risk remains
- How to verify it
