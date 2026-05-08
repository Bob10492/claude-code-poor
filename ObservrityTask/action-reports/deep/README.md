# Deep Action Reports

## What This Folder Is

This folder contains V1.1 deep reports for a single `user_action_id`.

Each action output normally includes:

- `deep_report.md`
- `rich_stage_flow.mmd`
- `debug_chain_flow.mmd`
- `phase_timeline_mapping.csv`
- `tool_calls_rich.csv`
- `artifact_chain.csv`
- `snapshot_evidence_index.csv`

## Simple Action vs Complex Action

`simple action` usually means one of these:

- a very short action with `tool_call_count <= 3`
- an interrupted action
- an observability self-run action such as `explain_action` or `deep_explain_action`
- a task that never entered a real script -> check -> edit -> rerun loop

`complex action` usually means:

- many turns and many tools
- multiple scripts or script versions
- file artifacts that are created, checked, modified, and regenerated
- visible repair loops such as `Bash failed -> Edit -> Bash rerun -> verification`

## Why `-Latest` May Pick The Wrong Action

`-Latest` simply selects the newest action in the V1 DuckDB tables.

That is often not the task you want. It can easily be:

- an observability/debug command action
- a self-run of `explain_action.ps1`
- a `deep_explain_action.ps1` validation run

For that reason the report adds a warning when the selection mode is `latest`.

## Prefer Explicit `UserActionId`

Use explicit selection when validating a real complex task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/observability/deep_explain_action.ps1 `
  -UserActionId 0e05fe1b-ece6-4f6b-9f90-b862e0e88308
```

Use `-Latest` only for quick smoke checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/observability/deep_explain_action.ps1 -Latest
```

## How To Read The Outputs

Read in this order:

1. `deep_report.md`
2. `rich_stage_flow.mmd`
3. `debug_chain_flow.mmd`
4. CSV files for drill-down

`deep_report.md` is the main narrative view:

- basics and selection mode
- warning if `latest` likely selected a self-run action
- phase-by-phase reason / action / result / artifacts / evidence

`rich_stage_flow.mmd` is the main DAG:

- action summary node
- query/subagent overview nodes
- one `subgraph` per phase
- tool nodes inside each phase
- artifact nodes
- evidence nodes
- cross-phase artifact flow and repair hints

`debug_chain_flow.mmd` is the repair-focused DAG:

- problem
- root cause guess
- fix actions
- rerun or verification
- resolved vs unresolved status

`tool_calls_rich.csv` is the detailed tool ledger:

- Bash command
- Write/Edit input
- after-turn or related snapshot result summaries
- detected problem / fix signal

`phase_timeline_mapping.csv` is the phase timeline:

- phase ids
- summaries
- tool ids
- primary artifacts
- evidence refs

## Recommended Validation Pattern

Use two samples:

- one simple/self-run sample to validate warning behavior
- one explicit complex `user_action_id` to validate rich DAG generation

The complex PPT sample used during this repair pass was:

- `0e05fe1b-ece6-4f6b-9f90-b862e0e88308`
