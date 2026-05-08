import type {
  ActionRow,
  ArtifactRecord,
  EvidenceRecord,
  PhaseRecord,
  QueryRow,
  RepairChain,
  RichToolCall,
  SubagentRow,
} from "./deep_action_types"

function esc(text: string): string {
  return text.replaceAll('"', "'").replaceAll("\n", "<br/>")
}

function shortText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/gu, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function shortId(value: string | null | undefined): string {
  if (!value) return "null"
  return value.length <= 8 ? value : value.slice(0, 8)
}

function nodeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/gu, "_")
}

function toolSummary(tool: RichToolCall): string {
  const status =
    tool.success === true ? "success" : tool.success === false ? "fail" : "unknown"
  return esc(
    [
      `turn ${tool.turn_id ?? "?"} | ${tool.tool_name} | ${status}`,
      shortText(tool.command_or_path || tool.input_summary || "input unavailable", 90),
      shortText(tool.detected_problem || tool.result_summary_rich || tool.output_summary || "no result", 110),
    ].join("<br/>"),
  )
}

function artifactSummary(artifact: ArtifactRecord): string {
  return esc(
    [
      artifact.artifact_path.split("/").at(-1) ?? artifact.artifact_path,
      `type=${artifact.artifact_type}`,
      artifact.created_by_phase_id ? `from ${artifact.created_by_phase_id}` : "",
    ]
      .filter(Boolean)
      .join("<br/>"),
  )
}

function evidenceSummary(evidence: EvidenceRecord): string {
  return esc(
    [
      evidence.category ?? "snapshot",
      shortId(evidence.snapshot_ref),
      shortText(evidence.summary, 80),
    ].join("<br/>"),
  )
}

export function buildRichStageFlow(params: {
  action: ActionRow
  queries: QueryRow[]
  subagents: SubagentRow[]
  phases: PhaseRecord[]
  tools: RichToolCall[]
  artifacts: ArtifactRecord[]
  evidence: EvidenceRecord[]
  repairChains: RepairChain[]
}): string {
  const lines = [
    "flowchart TD",
    "  classDef action fill:#111827,stroke:#0f172a,color:#f9fafb",
    "  classDef query fill:#ecfeff,stroke:#0f766e,color:#042f2e",
    "  classDef subagent fill:#fff7ed,stroke:#c2410c,color:#431407",
    "  classDef summary fill:#f8fafc,stroke:#64748b,color:#0f172a",
    "  classDef tool fill:#eef2ff,stroke:#4338ca,color:#1e1b4b",
    "  classDef toolFail fill:#fff1f2,stroke:#e11d48,color:#4c0519",
    "  classDef artifact fill:#fef3c7,stroke:#b45309,color:#451a03",
    "  classDef artifactFinal fill:#dcfce7,stroke:#16a34a,color:#14532d",
    "  classDef evidence fill:#ede9fe,stroke:#7c3aed,color:#2e1065",
    "  classDef more fill:#f1f5f9,stroke:#94a3b8,color:#334155",
    "  classDef repair fill:#fce7f3,stroke:#a21caf,color:#4a044e",
  ]

  lines.push(
    `  ACTION["${esc(
      [
        `action ${shortId(params.action.user_action_id)}`,
        `duration ${params.action.duration_ms}ms`,
        `queries ${params.action.query_count} | subagents ${params.action.subagent_count} | tools ${params.action.tool_call_count}`,
        `billed ${params.action.total_billed_tokens} tokens`,
      ].join("<br/>"),
    )}"]`,
  )
  lines.push("  class ACTION action")

  params.queries.forEach((query, index) => {
    const id = `Q${index + 1}`
    const kind = (query.query_source ?? "").includes("compact")
      ? "compact"
      : query.subagent_id
        ? "fork subagent"
        : "main_thread"
    lines.push(
      `  ${id}["${esc(
        [
          `${kind} ${shortId(query.query_id)}`,
          `turns ${query.turn_count} | tools ${query.tool_call_count}`,
          `duration ${query.duration_ms ?? 0}ms`,
          `terminal ${shortText(query.terminal_reason ?? "unknown", 60)}`,
        ].join("<br/>"),
      )}"]`,
    )
    lines.push(`  ACTION --> ${id}`)
    lines.push(`  class ${id} ${query.subagent_id ? "subagent" : "query"}`)
  })

  params.subagents.forEach((subagent, index) => {
    const id = `SA${index + 1}`
    lines.push(
      `  ${id}["${esc(
        [
          `fork ${shortId(subagent.subagent_id)}`,
          shortText(subagent.subagent_reason ?? subagent.subagent_type ?? "subagent", 70),
          `duration ${subagent.duration_ms ?? 0}ms`,
        ].join("<br/>"),
      )}"]`,
    )
    lines.push("  class " + id + " subagent")
  })

  const toolsById = new Map(params.tools.map(tool => [tool.tool_call_id, tool]))
  const evidenceById = new Map(params.evidence.map(item => [item.evidence_id, item]))
  const evidenceByRef = new Map(params.evidence.map(item => [item.snapshot_ref, item]))
  const phaseSummaryNodes: string[] = []

  params.phases.forEach((phase, index) => {
    const subgraphId = `PH${index + 1}`
    const summaryNodeId = `${subgraphId}_SUM`
    phaseSummaryNodes.push(summaryNodeId)
    const toolNames = Object.entries(phase.tool_counts)
      .map(([name, count]) => `${name}x${count}`)
      .join(" + ")
    lines.push(
      `  subgraph ${subgraphId}["${esc(
        `${phase.phase_id} ${phase.phase_name} | ${phase.start_local} | turns ${phase.turn_ids.join(",") || "-"} | ${toolNames || "no tools"}`,
      )}"]`,
    )
    lines.push(
      `    ${summaryNodeId}["${esc(
        [
          `reason: ${shortText(phase.reason_summary, 90)}`,
          `action: ${shortText(phase.action_summary, 90)}`,
          `result: ${shortText(phase.result_summary, 90)}`,
        ].join("<br/>"),
      )}"]`,
    )
    lines.push(`    class ${summaryNodeId} summary`)

    const phaseTools = phase.phase_tool_call_ids
      .map(id => toolsById.get(id))
      .filter((tool): tool is RichToolCall => Boolean(tool))
    phaseTools.slice(0, 5).forEach((tool, toolIndex) => {
      const toolId = `${subgraphId}_T${toolIndex + 1}`
      lines.push(`    ${toolId}["${toolSummary(tool)}"]`)
      lines.push(`    class ${toolId} ${tool.success === false || tool.detected_problem ? "toolFail" : "tool"}`)
      lines.push(`    ${summaryNodeId} --> ${toolId}`)
    })
    if (phaseTools.length > 5) {
      const moreId = `${subgraphId}_TMORE`
      lines.push(`    ${moreId}["+${phaseTools.length - 5} more tools in CSV"]`)
      lines.push(`    class ${moreId} more`)
      lines.push(`    ${summaryNodeId} --> ${moreId}`)
    }

    const phaseArtifacts = params.artifacts.filter(
      artifact =>
        artifact.created_by_phase_id === phase.phase_id ||
        artifact.first_seen_phase === phase.phase_id ||
        phase.primary_artifacts.includes(artifact.artifact_path),
    )
    phaseArtifacts.slice(0, 3).forEach((artifact, artifactIndex) => {
      const artifactId = `${subgraphId}_A${artifactIndex + 1}`
      lines.push(`    ${artifactId}["${artifactSummary(artifact)}"]`)
      lines.push(`    class ${artifactId} ${artifact.artifact_type === "final" ? "artifactFinal" : "artifact"}`)
      lines.push(`    ${summaryNodeId} --> ${artifactId}`)
    })

    const phaseEvidence = phase.evidence_refs
      .map(ref => evidenceByRef.get(ref))
      .filter((item): item is EvidenceRecord => Boolean(item))
      .slice(0, 2)
    phaseEvidence.forEach((item, evidenceIndex) => {
      const evidenceId = `${subgraphId}_E${evidenceIndex + 1}`
      lines.push(`    ${evidenceId}["${evidenceSummary(item)}"]`)
      lines.push(`    class ${evidenceId} evidence`)
      lines.push(`    ${summaryNodeId} --> ${evidenceId}`)
    })

    lines.push("  end")
    if (index === 0) {
      lines.push(`  ACTION --> ${summaryNodeId}`)
    } else {
      lines.push(`  ${phaseSummaryNodes[index - 1]} --> ${summaryNodeId}`)
    }
  })

  params.artifacts.forEach((artifact, index) => {
    if (!artifact.created_by_phase_id) return
    const sourceSummary = `PH${params.phases.findIndex(phase => phase.phase_id === artifact.created_by_phase_id) + 1}_SUM`
    artifact.phase_ids
      .filter(phaseId => phaseId !== artifact.created_by_phase_id)
      .slice(0, 3)
      .forEach(targetPhaseId => {
        const targetIndex = params.phases.findIndex(phase => phase.phase_id === targetPhaseId)
        if (targetIndex < 0) return
        const targetSummary = `PH${targetIndex + 1}_SUM`
        const hiddenArtifactNode = `AFLOW_${index + 1}_${targetIndex + 1}`
        lines.push(`  ${hiddenArtifactNode}["${esc(shortText(artifact.artifact_path.split("/").at(-1) ?? artifact.artifact_path, 60))}"]`)
        lines.push(`  class ${hiddenArtifactNode} ${artifact.artifact_type === "final" ? "artifactFinal" : "artifact"}`)
        lines.push(`  ${sourceSummary} --> ${hiddenArtifactNode}`)
        lines.push(`  ${hiddenArtifactNode} --> ${targetSummary}`)
      })
  })

  params.repairChains.forEach((chain, index) => {
    const firstPhaseId = chain.phase_ids[0]
    const lastPhaseId = chain.phase_ids.at(-1)
    const firstPhaseIndex = params.phases.findIndex(phase => phase.phase_id === firstPhaseId)
    const lastPhaseIndex = params.phases.findIndex(phase => phase.phase_id === lastPhaseId)
    if (firstPhaseIndex < 0 || lastPhaseIndex < 0) return
    const chainId = `RC${index + 1}`
    lines.push(`  ${chainId}["${esc(shortText(chain.problem_summary, 80))}"]`)
    lines.push(`  class ${chainId} repair`)
    lines.push(`  PH${firstPhaseIndex + 1}_SUM -. repair .-> ${chainId}`)
    lines.push(`  ${chainId} -. verify .-> PH${lastPhaseIndex + 1}_SUM`)
  })

  return lines.join("\n")
}

export function buildDebugChainFlow(params: {
  repairChains: RepairChain[]
  tools: RichToolCall[]
  artifacts: ArtifactRecord[]
  evidence: EvidenceRecord[]
}): string {
  const lines = [
    "flowchart TD",
    "  classDef problem fill:#fee2e2,stroke:#dc2626,color:#450a0a",
    "  classDef root fill:#fef3c7,stroke:#d97706,color:#451a03",
    "  classDef fix fill:#f3e8ff,stroke:#9333ea,color:#3b0764",
    "  classDef verification fill:#dbeafe,stroke:#2563eb,color:#172554",
    "  classDef resolved fill:#dcfce7,stroke:#16a34a,color:#14532d",
    "  classDef unresolved fill:#fed7aa,stroke:#ea580c,color:#431407",
  ]

  if (params.repairChains.length === 0) {
    lines.push('  D1["no dense repair chain detected"]')
    lines.push("  class D1 resolved")
    return lines.join("\n")
  }

  params.repairChains.forEach((chain, index) => {
    const base = `D${index + 1}`
    const problemId = `${base}_P`
    const rootId = `${base}_R`
    const verificationId = `${base}_V`
    const resultId = `${base}_O`
    lines.push(`  ${problemId}["${esc(shortText(chain.problem_summary, 90))}"]`)
    lines.push(`  ${rootId}["${esc(chain.root_cause_guess)}"]`)
    lines.push(`  ${verificationId}["${esc(shortText(chain.verification_summary, 90))}"]`)
    lines.push(`  ${resultId}["${esc(chain.status)}"]`)
    lines.push(`  class ${problemId} problem`)
    lines.push(`  class ${rootId} root`)
    lines.push(`  class ${verificationId} verification`)
    lines.push(`  class ${resultId} ${chain.status === "resolved" ? "resolved" : "unresolved"}`)
    lines.push(`  ${problemId} --> ${rootId}`)

    let previous = rootId
    chain.fix_actions.slice(0, 4).forEach((fix, fixIndex) => {
      const fixId = `${base}_F${fixIndex + 1}`
      lines.push(`  ${fixId}["${esc(shortText(fix, 90))}"]`)
      lines.push(`  class ${fixId} fix`)
      lines.push(`  ${previous} --> ${fixId}`)
      previous = fixId
    })

    lines.push(`  ${previous} --> ${verificationId}`)
    lines.push(`  ${verificationId} --> ${resultId}`)
  })

  return lines.join("\n")
}
