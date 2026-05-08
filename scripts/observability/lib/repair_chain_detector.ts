import type { ArtifactRecord, PhaseRecord, RepairChain, RichToolCall } from "./deep_action_types"

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function shortText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function toolMs(tool: RichToolCall): number {
  return Date.parse(tool.detected_at ?? tool.completed_at ?? new Date(0).toISOString())
}

function isProblemTool(tool: RichToolCall): boolean {
  return Boolean(tool.success === false || tool.detected_problem || /found|remaining|residue|error|failed|timeout|permission|readonly|locked/iu.test(tool.result_summary_rich))
}

function isFixTool(tool: RichToolCall): boolean {
  return Boolean(
    tool.tool_name === "Edit" ||
      tool.tool_name === "MultiEdit" ||
      tool.detected_fix_signal ||
      /fix|patch|replace|rewrite|remove|delete|rename|chmod|save|regenerate|rerun|修改|修复|替换|删除|重新生成/iu.test(
        `${tool.input_summary} ${tool.result_summary_rich}`,
      ),
  )
}

function isRunTool(tool: RichToolCall): boolean {
  return tool.tool_name === "Bash" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)
}

function isVerificationTool(tool: RichToolCall): boolean {
  return /check|verify|scan|grep|read|inspect|find|layout|bounds/iu.test(
    `${tool.tool_name} ${tool.input_summary} ${tool.command_or_path} ${tool.result_summary_rich}`,
  )
}

function rootCauseGuess(text: string): string {
  const lowered = text.toLowerCase()
  if (/readonly|locked|save|copy2|permission/iu.test(lowered)) return "save_or_permission_repair"
  if (/ncalnn|ncalnnn|repeated replace/iu.test(lowered)) return "replacement_pollution_repair"
  if (/master|footer|run|xml|a:t/iu.test(lowered)) return "ppt_xml_or_footer_repair"
  if (/residue|remaining|found/iu.test(lowered)) return "residue_scan_repair"
  return "generic_execution_repair"
}

function buildChain(
  chainIndex: number,
  tools: RichToolCall[],
  phaseByToolId: Map<string, PhaseRecord>,
): RepairChain {
  const problemTool = tools[0]!
  const fixTools = tools.filter(isFixTool)
  const verificationTools = tools.filter(isVerificationTool)
  const phaseIds = unique(tools.map(tool => phaseByToolId.get(tool.tool_call_id)?.phase_id ?? "unknown"))
  const artifactPaths = unique(tools.flatMap(tool => [...tool.produced_files, ...tool.result_files, ...tool.touched_files]))
  const evidenceRefs = unique(tools.flatMap(tool => tool.evidence_refs))
  const verificationSummary =
    verificationTools.at(-1)?.result_summary_rich ??
    tools.at(-1)?.result_summary_rich ??
    "verification unavailable"
  const resolved = !verificationTools.some(tool => isProblemTool(tool)) && !isProblemTool(tools.at(-1)!)

  return {
    chain_id: `repair_${String(chainIndex).padStart(2, "0")}`,
    problem_summary: shortText(problemTool.detected_problem || problemTool.result_summary_rich || problemTool.output_summary),
    root_cause_guess: rootCauseGuess(
      tools
        .map(tool => [tool.detected_problem, tool.detected_fix_signal, tool.result_summary_rich].filter(Boolean).join(" "))
        .join(" "),
    ),
    fix_actions: unique(fixTools.map(tool => shortText(`${tool.tool_name}: ${tool.command_or_path || tool.input_summary || tool.detected_fix_signal}`))),
    verification_summary: shortText(verificationSummary),
    tool_call_ids: tools.map(tool => tool.tool_call_id),
    phase_ids: phaseIds,
    artifact_paths: artifactPaths,
    evidence_refs: evidenceRefs,
    status: resolved ? "resolved" : "unresolved",
  }
}

export function detectRepairChains(params: {
  richTools: RichToolCall[]
  phases: PhaseRecord[]
  artifacts: ArtifactRecord[]
}): RepairChain[] {
  const sortedTools = [...params.richTools].sort((left, right) => toolMs(left) - toolMs(right))
  const phaseByToolId = new Map<string, PhaseRecord>()
  for (const phase of params.phases) {
    for (const toolCallId of phase.phase_tool_call_ids) {
      phaseByToolId.set(toolCallId, phase)
    }
  }

  const chains: RepairChain[] = []
  const used = new Set<string>()

  for (let index = 0; index < sortedTools.length; index += 1) {
    const start = sortedTools[index]!
    if (used.has(start.tool_call_id) || !isProblemTool(start)) continue

    const windowTools = [start]
    let sawFix = false
    let sawRerun = false
    let sawVerification = false
    const startMs = toolMs(start)

    for (let cursor = index + 1; cursor < sortedTools.length; cursor += 1) {
      const current = sortedTools[cursor]!
      if (toolMs(current) - startMs > 10 * 60 * 1000) break
      if (current.query_id !== start.query_id && current.agent_name === start.agent_name) break

      const relatedArtifact = current.touched_files.some(path => start.produced_files.includes(path) || start.result_files.includes(path))
      const sameLoop =
        isFixTool(current) ||
        isRunTool(current) ||
        isVerificationTool(current) ||
        relatedArtifact ||
        /readonly|locked|save|copy2|permission|ncalnn|ncalnnn|master|footer|xml|a:t|residue|remaining/iu.test(
          `${current.input_summary} ${current.result_summary_rich}`,
        )

      if (!sameLoop) continue

      windowTools.push(current)
      if (isFixTool(current)) sawFix = true
      if (isRunTool(current) && sawFix) sawRerun = true
      if (isVerificationTool(current) && (sawFix || sawRerun)) sawVerification = true
    }

    const denseLoop =
      windowTools.length >= 4 &&
      windowTools.filter(tool => isFixTool(tool) || isVerificationTool(tool) || isRunTool(tool)).length >= 3

    if ((sawFix && sawRerun) || (sawFix && sawVerification) || denseLoop) {
      const chain = buildChain(chains.length + 1, windowTools, phaseByToolId)
      chains.push(chain)
      for (const tool of windowTools) used.add(tool.tool_call_id)
    }
  }

  return chains
}
