import type { ActionRow, ArtifactRecord, PhaseRecord, QueryRow, RichToolCall, TurnRow } from "./deep_action_types"

type ToolMarker = {
  signature: string
  phaseName: string
  stageKind: PhaseRecord["stage_kind"]
  reason: string
  action: string
  result: string
  primaryArtifacts: string[]
  problems: string[]
  fixes: string[]
  forceBoundaryBefore: boolean
  forceBoundaryAfter: boolean
  queryId: string | null
  turnId: string | null
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function localText(value: number): string {
  return new Date(value).toLocaleString("sv-SE").replace("T", " ")
}

function shortText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/gu, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function fileBase(path: string): string {
  const normalized = path.replace(/\\/gu, "/")
  return normalized.split("/").at(-1) ?? normalized
}

function scriptNameFromTool(tool: RichToolCall): string {
  const haystack = [tool.command_or_path, tool.input_summary, tool.result_summary_rich]
    .filter(Boolean)
    .join(" ")
  const match = haystack.match(/([A-Za-z0-9_.-]+\.(?:py|js|ts|ps1))/iu)
  return match?.[1] ?? ""
}

function haystack(tool: RichToolCall, query: QueryRow | undefined): string {
  return [
    tool.tool_name,
    tool.input_summary,
    tool.command_or_path,
    tool.result_summary_rich,
    tool.prompt_summary,
    query?.query_source ?? "",
    query?.subagent_reason ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

function containsCheckSignal(tool: RichToolCall, query: QueryRow | undefined): boolean {
  return /check|inspect|verify|scan|grep|find|search|overlap|bounds|layout|read|compare|diff|look for|remaining/iu.test(
    haystack(tool, query),
  )
}

function inferStageKind(tool: RichToolCall, query: QueryRow | undefined): PhaseRecord["stage_kind"] {
  if ((query?.query_source ?? "").toLowerCase().includes("compact")) return "compact"
  if (tool.tool_name === "Agent") return "subagent"
  if (tool.tool_name === "Write" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return "script"
  if (tool.tool_name === "Bash" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return "script"
  if (tool.tool_name === "Edit" || tool.tool_name === "MultiEdit" || tool.detected_fix_signal) return "fix"
  if (tool.success === false || tool.detected_problem) return "issue"
  if (tool.produced_files.some(path => /\.pptx$/iu.test(path))) return "output"
  if (query?.subagent_id || (tool.agent_name && tool.agent_name !== "main_thread")) return "subagent"
  if (tool.tool_name === "Read" || tool.tool_name === "Grep" || tool.tool_name === "Glob") return "input"
  return "main"
}

function inferPhaseCluster(tool: RichToolCall, query: QueryRow | undefined): { name: string; signature: string } {
  const scriptName = scriptNameFromTool(tool)
  const text = haystack(tool, query)
  const compactQuery = (query?.query_source ?? "").toLowerCase().includes("compact")
  const subagentQuery = Boolean(query?.subagent_id || (tool.agent_name && tool.agent_name !== "main_thread"))

  if (compactQuery) return { name: "compact carry-forward", signature: "compact" }
  if (tool.tool_name === "Agent") return { name: "fork subagents", signature: "fork-subagents" }
  if (tool.tool_name === "Write" && scriptName) return { name: `write script ${scriptName}`, signature: `write-script:${scriptName}` }
  if (tool.tool_name === "Bash" && scriptName) return { name: `run script ${scriptName}`, signature: `run-script:${scriptName}` }
  if ((tool.tool_name === "Edit" || tool.tool_name === "MultiEdit") && scriptName) return { name: `edit script ${scriptName}`, signature: `edit-script:${scriptName}` }
  if (/pip install|pip3 install|where python|python --version|import docx|import pptx/iu.test(text)) {
    return { name: "environment setup and dependency checks", signature: `env-setup:${subagentQuery ? "subagent" : "main"}` }
  }
  if (subagentQuery && /docx|thesis|论文|extract/.test(text)) {
    return { name: "subagent thesis extraction", signature: "subagent-thesis-extraction" }
  }
  if (subagentQuery && /pptx|template|slide|layout|master|footer|xml/.test(text)) {
    return { name: "subagent template analysis", signature: "subagent-template-analysis" }
  }
  if (subagentQuery) {
    return { name: "subagent evidence review", signature: "subagent-evidence-review" }
  }
  if (tool.success === false || /readonly|locked|permission|denied|timeout|traceback|exception/.test(text)) {
    return { name: "execution or repair issue detection", signature: "issue-detection" }
  }
  if (tool.tool_name === "Edit" || tool.tool_name === "MultiEdit" || tool.detected_fix_signal) {
    return { name: "repair and adjustment edits", signature: "repair-edits" }
  }
  if (containsCheckSignal(tool, query) && /ppt|output|analysis|check|verify|remaining|residue|ncalnn|footer/.test(text)) {
    return { name: "output verification and residue checks", signature: "output-verification" }
  }
  if (containsCheckSignal(tool, query) && /docx|thesis|template|spec|txt/.test(text)) {
    return { name: "input collection and source review", signature: "input-review" }
  }
  if (tool.produced_files.some(path => /\.pptx$/iu.test(path))) {
    return { name: `generate ${fileBase(tool.produced_files.find(path => /\.pptx$/iu.test(path)) ?? "deck.pptx")}`, signature: `generate-ppt:${fileBase(tool.produced_files.find(path => /\.pptx$/iu.test(path)) ?? "deck.pptx")}` }
  }
  if (tool.tool_name === "Write") return { name: `write ${fileBase(tool.command_or_path || tool.produced_files[0] || "file")}`, signature: `write:${fileBase(tool.command_or_path || tool.produced_files[0] || "file")}` }
  if (tool.tool_name === "Bash") return { name: "bash execution and checks", signature: `bash-checks:${subagentQuery ? "subagent" : "main"}` }
  if (tool.tool_name === "Read" || tool.tool_name === "Grep" || tool.tool_name === "Glob") {
    return { name: "input collection and source review", signature: `inspect:${subagentQuery ? "subagent" : "main"}` }
  }
  return { name: `${tool.tool_name.toLowerCase()} flow`, signature: `${tool.tool_name.toLowerCase()}-flow` }
}

function buildReason(tool: RichToolCall, query: QueryRow | undefined): string {
  return shortText(
    tool.detected_problem ||
      query?.subagent_reason ||
      tool.prompt_summary ||
      query?.terminal_reason ||
      tool.input_summary ||
      tool.command_or_path ||
      "continue action flow",
    180,
  )
}

function buildAction(tool: RichToolCall): string {
  return shortText(
    tool.command_or_path ? `${tool.tool_name}: ${tool.command_or_path}` : `${tool.tool_name}: ${tool.input_summary}`,
    180,
  )
}

function buildResult(tool: RichToolCall): string {
  return shortText(
    tool.result_summary_rich ||
      tool.output_summary ||
      tool.result_files[0] ||
      tool.produced_files[0] ||
      (tool.success === true ? "completed" : tool.success === false ? "failed" : "done"),
    220,
  )
}

function forceBoundaryBefore(tool: RichToolCall, previous: RichToolCall | null, query: QueryRow | undefined): boolean {
  if (!previous) return true
  if (tool.query_id !== previous.query_id) return true
  if ((query?.query_source ?? "").toLowerCase().includes("compact")) return true
  if (tool.tool_name === "Agent") return true
  if (tool.tool_name === "Write" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return true
  if (tool.tool_name === "Bash" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return true
  if (tool.success === false) return true
  if (tool.tool_name === "Edit" || tool.tool_name === "MultiEdit") return true
  if (tool.detected_problem || tool.detected_fix_signal) return true
  if (containsCheckSignal(tool, query) && previous.produced_files.length > 0) return true
  if (tool.produced_files.some(path => /\.pptx$/iu.test(path)) && previous.produced_files.join("|") !== tool.produced_files.join("|")) return true
  return false
}

function forceBoundaryAfter(tool: RichToolCall, query: QueryRow | undefined): boolean {
  if ((query?.query_source ?? "").toLowerCase().includes("compact")) return true
  if (tool.tool_name === "Agent") return true
  if (tool.tool_name === "Write" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return true
  if (tool.tool_name === "Bash" && /\.(py|js|ts|ps1)\b/iu.test(tool.command_or_path)) return true
  if (tool.tool_name === "Edit" || tool.tool_name === "MultiEdit") return true
  if (tool.success === false) return true
  if (tool.detected_problem || tool.detected_fix_signal) return true
  return false
}

function makeMarker(tool: RichToolCall, previous: RichToolCall | null, query: QueryRow | undefined): ToolMarker {
  const cluster = inferPhaseCluster(tool, query)
  return {
    signature: cluster.signature,
    phaseName: cluster.name,
    stageKind: inferStageKind(tool, query),
    reason: buildReason(tool, query),
    action: buildAction(tool),
    result: buildResult(tool),
    primaryArtifacts: unique([...tool.produced_files, ...tool.result_files].slice(0, 4)),
    problems: tool.detected_problem ? [tool.detected_problem] : tool.success === false ? [tool.output_summary] : [],
    fixes: tool.detected_fix_signal ? [tool.detected_fix_signal] : [],
    forceBoundaryBefore: forceBoundaryBefore(tool, previous, query),
    forceBoundaryAfter: forceBoundaryAfter(tool, query),
    queryId: tool.query_id,
    turnId: tool.turn_id,
  }
}

function appendCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function canMergePhase(current: PhaseRecord, marker: ToolMarker, tool: RichToolCall, startMs: number): boolean {
  if (marker.forceBoundaryBefore) return false
  if (current.phase_name !== marker.phaseName) return false
  if (current.stage_kind !== marker.stageKind) return false
  if (marker.queryId && current.query_ids.at(-1) !== marker.queryId) return false
  if (tool.detected_problem || tool.detected_fix_signal) return false
  if (startMs - current.end_ms > 5 * 60 * 1000) return false
  const maxTools =
    current.stage_kind === "input" || current.stage_kind === "main" || current.stage_kind === "subagent" ? 10 : 6
  return current.phase_tool_call_ids.length < maxTools
}

function createPhase(index: number, tool: RichToolCall, marker: ToolMarker, startMs: number, endMs: number): PhaseRecord {
  return {
    phase_id: `phase_${String(index).padStart(2, "0")}`,
    phase_name: marker.phaseName,
    stage_kind: marker.stageKind,
    start_local: localText(startMs),
    end_local: localText(endMs),
    duration_ms: Math.max(endMs - startMs, 0),
    start_ms: startMs,
    end_ms: endMs,
    query_ids: marker.queryId ? [marker.queryId] : [],
    turn_ids: marker.turnId ? [marker.turnId] : [],
    tool_counts: { [tool.tool_name]: 1 },
    main_outputs: marker.result ? [marker.result] : [],
    problems: [...marker.problems],
    fixes: [...marker.fixes],
    evidence_refs: [...tool.evidence_refs],
    tool_call_ids: [tool.tool_call_id],
    phase_tool_call_ids: [tool.tool_call_id],
    primary_artifacts: [...marker.primaryArtifacts],
    reason_summary: marker.reason,
    action_summary: marker.action,
    result_summary: marker.result,
  }
}

function mergeIntoPhase(phase: PhaseRecord, tool: RichToolCall, marker: ToolMarker, endMs: number): void {
  phase.end_ms = Math.max(phase.end_ms, endMs)
  phase.end_local = localText(phase.end_ms)
  phase.duration_ms = Math.max(phase.end_ms - phase.start_ms, 0)
  if (marker.queryId && !phase.query_ids.includes(marker.queryId)) phase.query_ids.push(marker.queryId)
  if (marker.turnId && !phase.turn_ids.includes(marker.turnId)) phase.turn_ids.push(marker.turnId)
  appendCount(phase.tool_counts, tool.tool_name)
  phase.tool_call_ids = unique([...phase.tool_call_ids, tool.tool_call_id])
  phase.phase_tool_call_ids = unique([...phase.phase_tool_call_ids, tool.tool_call_id])
  phase.main_outputs = unique([...phase.main_outputs, marker.result].filter(Boolean))
  phase.problems = unique([...phase.problems, ...marker.problems])
  phase.fixes = unique([...phase.fixes, ...marker.fixes])
  phase.evidence_refs = unique([...phase.evidence_refs, ...tool.evidence_refs])
  phase.primary_artifacts = unique([...phase.primary_artifacts, ...marker.primaryArtifacts])
  phase.reason_summary = shortText(unique([phase.reason_summary, marker.reason]).filter(Boolean).join(" | "), 220)
  phase.action_summary = shortText(unique([phase.action_summary, marker.action]).filter(Boolean).join(" | "), 220)
  phase.result_summary = shortText(unique([phase.result_summary, marker.result]).filter(Boolean).join(" | "), 240)
}

function mergePhaseRecords(target: PhaseRecord, source: PhaseRecord): void {
  target.end_ms = Math.max(target.end_ms, source.end_ms)
  target.end_local = localText(target.end_ms)
  target.duration_ms = Math.max(target.end_ms - target.start_ms, 0)
  target.query_ids = unique([...target.query_ids, ...source.query_ids])
  target.turn_ids = unique([...target.turn_ids, ...source.turn_ids])
  for (const [toolName, count] of Object.entries(source.tool_counts)) {
    target.tool_counts[toolName] = (target.tool_counts[toolName] ?? 0) + count
  }
  target.main_outputs = unique([...target.main_outputs, ...source.main_outputs])
  target.problems = unique([...target.problems, ...source.problems])
  target.fixes = unique([...target.fixes, ...source.fixes])
  target.evidence_refs = unique([...target.evidence_refs, ...source.evidence_refs])
  target.tool_call_ids = unique([...target.tool_call_ids, ...source.tool_call_ids])
  target.phase_tool_call_ids = unique([...target.phase_tool_call_ids, ...source.phase_tool_call_ids])
  target.primary_artifacts = unique([...target.primary_artifacts, ...source.primary_artifacts])
  target.reason_summary = shortText(unique([target.reason_summary, source.reason_summary]).join(" | "), 220)
  target.action_summary = shortText(unique([target.action_summary, source.action_summary]).join(" | "), 220)
  target.result_summary = shortText(unique([target.result_summary, source.result_summary]).join(" | "), 240)
}

function coalesceWithinQueryWindows(phases: PhaseRecord[]): PhaseRecord[] {
  const grouped = new Map<string, PhaseRecord[]>()
  for (const phase of phases) {
    const key = phase.query_ids[0] ?? "__unknown__"
    const list = grouped.get(key) ?? []
    list.push(phase)
    grouped.set(key, list)
  }

  const merged: PhaseRecord[] = []
  for (const queryPhases of grouped.values()) {
    const sorted = [...queryPhases].sort((left, right) => left.start_ms - right.start_ms)
    let current: PhaseRecord | null = null
    for (const phase of sorted) {
      const mergeableName =
        !/^write script |^run script /u.test(phase.phase_name)
      const canMerge =
        current &&
        mergeableName &&
        current.phase_name === phase.phase_name &&
        current.stage_kind === phase.stage_kind &&
        phase.start_ms - current.end_ms <= 10 * 60 * 1000 &&
        current.phase_tool_call_ids.length + phase.phase_tool_call_ids.length <= (phase.stage_kind === "fix" || phase.stage_kind === "issue" ? 8 : 18)

      if (!current || !canMerge) {
        current = {
          ...phase,
          query_ids: [...phase.query_ids],
          turn_ids: [...phase.turn_ids],
          tool_counts: { ...phase.tool_counts },
          main_outputs: [...phase.main_outputs],
          problems: [...phase.problems],
          fixes: [...phase.fixes],
          evidence_refs: [...phase.evidence_refs],
          tool_call_ids: [...phase.tool_call_ids],
          phase_tool_call_ids: [...phase.phase_tool_call_ids],
          primary_artifacts: [...phase.primary_artifacts],
        }
        merged.push(current)
      } else {
        mergePhaseRecords(current, phase)
      }
    }
  }
  return merged
}

function buildSummaryPhases(action: ActionRow, queries: QueryRow[], turns: TurnRow[], tools: RichToolCall[]): PhaseRecord[] {
  const queryById = new Map(queries.map(query => [query.query_id, query]))
  const toolsByQuery = new Map<string, RichToolCall[]>()
  for (const tool of tools) {
    const key = tool.query_id ?? "__unknown__"
    const list = toolsByQuery.get(key) ?? []
    list.push(tool)
    toolsByQuery.set(key, list)
  }

  const phases: PhaseRecord[] = []
  for (const queryTools of toolsByQuery.values()) {
    const sortedTools = [...queryTools].sort((left, right) => {
      const leftMs = Date.parse(left.detected_at ?? action.started_at)
      const rightMs = Date.parse(right.detected_at ?? action.started_at)
      return leftMs - rightMs
    })
    let current: PhaseRecord | null = null
    let previousTool: RichToolCall | null = null

    for (const tool of sortedTools) {
      const query = tool.query_id ? queryById.get(tool.query_id) : undefined
      const marker = makeMarker(tool, previousTool, query)
      const startMs = tool.detected_at ? Date.parse(tool.detected_at) : action.started_at_ms
      const endMs = tool.completed_at ? Date.parse(tool.completed_at) : startMs
      const merge = current ? canMergePhase(current, marker, tool, startMs) : false

      if (!current || !merge) {
        current = createPhase(phases.length + 1, tool, marker, startMs, endMs)
        phases.push(current)
      } else {
        mergeIntoPhase(current, tool, marker, endMs)
      }

      if (marker.forceBoundaryAfter) current = null
      previousTool = tool
    }
  }

  if (phases.length === 0) {
    return [
      {
        phase_id: "phase_01",
        phase_name: "action only",
        stage_kind: "main",
        start_local: localText(action.started_at_ms),
        end_local: localText(action.ended_at_ms),
        duration_ms: Math.max(action.ended_at_ms - action.started_at_ms, 0),
        start_ms: action.started_at_ms,
        end_ms: action.ended_at_ms,
        query_ids: queries.map(query => query.query_id),
        turn_ids: turns.map(turn => turn.turn_id),
        tool_counts: {},
        main_outputs: ["no tool calls captured"],
        problems: [],
        fixes: [],
        evidence_refs: [],
        tool_call_ids: [],
        phase_tool_call_ids: [],
        primary_artifacts: [],
        reason_summary: "no tool calls captured",
        action_summary: "action did not emit tools",
        result_summary: queries.at(-1)?.terminal_reason ?? "completed",
      },
    ]
  }

  return coalesceWithinQueryWindows(phases)
    .sort((left, right) => left.start_ms - right.start_ms)
    .map((phase, index) => ({
      ...phase,
      phase_id: `phase_${String(index + 1).padStart(2, "0")}`,
    }))
}

export function inferPhases(params: {
  action: ActionRow
  queries: QueryRow[]
  turns: TurnRow[]
  tools: RichToolCall[]
  artifacts?: ArtifactRecord[]
}): PhaseRecord[] {
  return buildSummaryPhases(params.action, params.queries, params.turns, params.tools)
}
