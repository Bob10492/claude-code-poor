import type {
  ActionRow,
  ArtifactRecord,
  EvidenceRecord,
  IntegrityRow,
  PhaseRecord,
  QueryRow,
  RepairChain,
  RichToolCall,
  SelectionMode,
  SubagentRow,
} from "./deep_action_types"

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function shortId(value: string | null | undefined): string {
  if (!value) return "null"
  return value.length <= 8 ? value : value.slice(0, 8)
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br/>")
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.join(" | ")} |`),
  ]
}

function describeTool(tool: RichToolCall): string {
  return `${tool.tool_name}${tool.success === false ? " fail" : tool.success === true ? " ok" : ""}`
}

function isSelfRunAction(tools: RichToolCall[], toolCallCount: number): boolean {
  if (toolCallCount > 3) return false
  const bashCommands = tools.filter(tool => tool.tool_name === "Bash").map(tool => tool.command_or_path.toLowerCase())
  return bashCommands.length === 1 && bashCommands[0]!.includes("explain_action")
}

export function writeDeepReport(params: {
  action: ActionRow
  integrity: IntegrityRow | null
  queries: QueryRow[]
  subagents: SubagentRow[]
  phases: PhaseRecord[]
  tools: RichToolCall[]
  artifacts: ArtifactRecord[]
  evidence: EvidenceRecord[]
  repairChains: RepairChain[]
  selectedBy: SelectionMode
  terminalReason: string
  richMermaidPath: string
  debugMermaidPath: string
  baselineReportPath: string | null
}): string {
  const missingSnapshotCount = params.tools.filter(tool => tool.warnings.length > 0).length
  const selfRun = isSelfRunAction(params.tools, params.action.tool_call_count)
  const toolsById = new Map(params.tools.map(tool => [tool.tool_call_id, tool]))
  const evidenceByRef = new Map(params.evidence.map(item => [item.snapshot_ref, item]))
  const lines: string[] = [
    "# Deep Action Report",
    "",
  ]

  if (params.selectedBy === "latest") {
    lines.push(
      "> Warning: Latest action may be an observability/debug command action. For complex DAG validation, prefer explicit `-UserActionId`.",
      "",
    )
  }

  if (selfRun) {
    lines.push(
      "> This appears to be an observability self-run action, not a target complex task.",
      "",
    )
  }

  lines.push("## How To Read", "")
  lines.push("- `rich_stage_flow.mmd`: phase structure, tool nodes, artifact nodes, evidence nodes.")
  lines.push("- `debug_chain_flow.mmd`: problem -> fix -> verification chains.")
  lines.push("- `deep_report.md`: per-phase reason, action, and result.")
  lines.push("- CSV files are drill-down detail, not the primary reading path.", "")

  lines.push("## Summary", "")
  lines.push(
    `This action expanded into ${params.phases.length} phases across ${params.action.query_count} queries, ${params.action.subagent_count} subagents, and ${params.action.tool_call_count} tool calls.`,
    "",
  )

  lines.push("## Basics", "")
  lines.push(`- user_action_id: ${params.action.user_action_id}`)
  lines.push(`- selected_by: ${params.selectedBy}`)
  lines.push(`- utc: ${params.action.started_at} -> ${params.action.ended_at}`)
  lines.push(`- duration_ms: ${params.action.duration_ms}`)
  lines.push(`- query_count: ${params.action.query_count}`)
  lines.push(`- subagent_count: ${params.action.subagent_count}`)
  lines.push(`- tool_call_count: ${params.action.tool_call_count}`)
  lines.push(`- terminal_reason: ${params.terminalReason}`)
  lines.push(`- total_prompt_input_tokens: ${params.action.total_prompt_input_tokens}`)
  lines.push(`- total_billed_tokens: ${params.action.total_billed_tokens}`)
  if (selfRun) {
    lines.push("- note: This appears to be an observability self-run action, not a target complex task.")
  }
  lines.push("")

  if (params.integrity) {
    lines.push("## Integrity Snapshot", "")
    for (const [key, value] of Object.entries(params.integrity)) {
      lines.push(`- ${key}: ${value ?? ""}`)
    }
    lines.push("")
  }

  lines.push("## Query And Subagent Overview", "")
  for (const query of params.queries) {
    lines.push(
      `- ${query.agent_name ?? "unknown"} ${shortId(query.query_id)}: source=${query.query_source ?? "main_thread"}, turns=${query.turn_count}, tools=${query.tool_call_count}, duration_ms=${query.duration_ms ?? ""}, terminal=${query.terminal_reason ?? ""}`,
    )
  }
  for (const subagent of params.subagents) {
    lines.push(
      `- subagent ${shortId(subagent.subagent_id)}: ${subagent.subagent_reason ?? ""}, duration_ms=${subagent.duration_ms ?? ""}, child_query=${shortId(subagent.query_id)}`,
    )
  }
  lines.push("")

  lines.push("## Graph Outputs", "")
  lines.push(`- rich stage flow: ${params.richMermaidPath}`)
  lines.push(`- debug chain flow: ${params.debugMermaidPath}`)
  if (params.baselineReportPath) {
    lines.push(`- baseline explain_action report: ${params.baselineReportPath}`)
  }
  lines.push("")

  lines.push("## Repair Chains", "")
  if (params.repairChains.length === 0) {
    lines.push("- no dense repair chain detected", "")
  } else {
    for (const chain of params.repairChains) {
      lines.push(
        `- ${chain.chain_id}: ${chain.problem_summary}; root=${chain.root_cause_guess}; fix=${chain.fix_actions.join(" | ") || "n/a"}; verification=${chain.verification_summary}; status=${chain.status}`,
      )
    }
    lines.push("")
  }

  for (const phase of params.phases) {
    const phaseTools = phase.phase_tool_call_ids
      .map(id => toolsById.get(id))
      .filter((tool): tool is RichToolCall => Boolean(tool))
    const phaseArtifacts = params.artifacts.filter(artifact => artifact.phase_ids.includes(phase.phase_id))
    const phaseEvidence = unique(phase.evidence_refs)
      .map(ref => evidenceByRef.get(ref))
      .filter((item): item is EvidenceRecord => Boolean(item))
    const phaseProblems = unique([...phase.problems, ...phaseTools.map(tool => tool.detected_problem).filter(Boolean)])
    const phaseFixes = unique([...phase.fixes, ...phaseTools.map(tool => tool.detected_fix_signal).filter(Boolean)])

    lines.push(`## Phase ${phase.phase_id.replace("phase_", "")}: ${phase.phase_name}`, "")
    lines.push(`- time: ${phase.start_local} -> ${phase.end_local} (${phase.duration_ms}ms)`)
    lines.push(`- query: ${phase.query_ids.map(shortId).join(", ") || "-"}`)
    lines.push(`- turn: ${phase.turn_ids.join(", ") || "-"}`)
    lines.push(`- tools: ${phaseTools.map(describeTool).join(", ") || "-"}`)
    lines.push(`- reason: ${phase.reason_summary || "-"}`)
    lines.push(`- action: ${phase.action_summary || "-"}`)
    lines.push(`- result: ${phase.result_summary || "-"}`)
    lines.push(`- artifacts: ${phase.primary_artifacts.join(" | ") || "-"}`)
    lines.push(`- problems: ${phaseProblems.join(" | ") || "-"}`)
    lines.push(`- fixes: ${phaseFixes.join(" | ") || "-"}`)
    lines.push(
      `- evidence: ${phaseEvidence.map(item => `${item.category ?? "snapshot"}:${shortId(item.snapshot_ref)}`).join(" | ") || "-"}`,
    )
    lines.push("", "### Tool Details", "")
    lines.push(
      ...table(
        ["turn", "tool", "command/path", "input摘要", "output摘要", "problem/fix", "evidence"],
        phaseTools.slice(0, 5).map(tool => [
          escapeCell(tool.turn_id ?? ""),
          escapeCell(tool.tool_name),
          escapeCell(tool.command_or_path || "-"),
          escapeCell(tool.input_summary || "-"),
          escapeCell(tool.result_summary_rich || tool.output_summary || "-"),
          escapeCell(unique([tool.detected_problem, tool.detected_fix_signal].filter(Boolean)).join(" | ") || "-"),
          escapeCell(tool.evidence_refs.slice(0, 2).map(shortId).join(", ") || "-"),
        ]),
      ),
    )
    if (phaseTools.length > 5) {
      lines.push("", `More tools in phase: ${phaseTools.length - 5} additional rows in tool_calls_rich.csv`)
    }

    lines.push("", "### Artifacts", "")
    if (phaseArtifacts.length === 0) {
      lines.push("- no explicit artifacts")
    } else {
      lines.push(
        ...table(
          ["artifact", "type", "created/modified by"],
          phaseArtifacts.slice(0, 8).map(artifact => [
            escapeCell(artifact.artifact_path),
            escapeCell(artifact.artifact_type),
            escapeCell(
              [
                artifact.created_by_tool ? `create:${artifact.created_by_tool}` : "",
                artifact.modified_by_tools.length > 0 ? `modify:${artifact.modified_by_tools.join(",")}` : "",
              ]
                .filter(Boolean)
                .join(" | ") || "-",
            ),
          ]),
        ),
      )
    }
    lines.push("")
  }

  lines.push("## Snapshot Evidence Index", "")
  lines.push(
    ...table(
      ["evidence_id", "category", "query", "turn", "fields", "summary"],
      params.evidence.slice(0, 40).map(item => [
        item.evidence_id,
        escapeCell(item.category ?? ""),
        escapeCell(shortId(item.query_id)),
        escapeCell(item.turn_id ?? ""),
        escapeCell(item.extracted_fields.join(", ")),
        escapeCell(item.summary),
      ]),
    ),
  )
  if (params.evidence.length > 40) {
    lines.push("", `More evidence rows: ${params.evidence.length - 40} omitted from report; see snapshot_evidence_index.csv`)
  }

  lines.push("", "## Confidence", "")
  lines.push(`- missing_snapshot_or_fallback_tool_calls: ${missingSnapshotCount}`)
  if (missingSnapshotCount > 0) {
    lines.push("- some tool results were reconstructed via related snapshots or turn fallback")
  }

  return lines.join("\n")
}
