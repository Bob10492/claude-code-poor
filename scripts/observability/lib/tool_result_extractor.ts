import type {
  JsonValue,
  RichToolCall,
  SnapshotRecord,
  ToolResultCandidate,
  TurnSnapshotBundle,
} from "./deep_action_types"

const PROBLEM_KEYWORDS = [
  "error",
  "failed",
  "failure",
  "denied",
  "permission",
  "readonly",
  "locked",
  "timeout",
  "interrupted",
  "traceback",
  "exception",
  "residue",
  "remaining",
  "found",
  "bfz",
  "gdc",
  "\u53ef\u9006SOFC",
  "\u53f6\u5148\u5706",
  "2024",
  "ncalnn",
  "ncalnnn",
]

const FIX_KEYWORDS = [
  "fix",
  "patch",
  "replace",
  "rewrite",
  "remove",
  "delete",
  "rename",
  "chmod",
  "save",
  "regenerate",
  "rerun",
  "\u4fee\u6539",
  "\u4fee\u590d",
  "\u66ff\u6362",
  "\u5220\u9664",
  "\u91cd\u65b0\u751f\u6210",
]

const FILE_HINT_KEYWORDS = [
  "saved",
  "generated",
  "written",
  "output",
  "created",
  "exported",
  "\u6587\u4ef6\u4f4d\u4e8e",
  "\u5df2\u751f\u6210",
]

const FILE_PATTERN =
  /([A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/])?[\w .-]+(?:[\\/][\w .-]+)*\.(?:docx|pptx|txt|json|py|js|ts|ps1|csv|md|xml|html|png|jpg|jpeg|svg|pdf|xlsx|output))/giu

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function asRecord(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, JsonValue>
}

function asArray(value: JsonValue | null | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function squash(text: string, maxLength = 220): string {
  const normalized = text
    .replace(/<local-command-(stdout|stderr)>/giu, "")
    .replace(/<\/local-command-(stdout|stderr)>/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function stringify(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function extractFiles(text: string): string[] {
  return unique([...text.matchAll(FILE_PATTERN)].map(match => (match[1] ?? "").trim()).filter(Boolean))
}

function findKeywordSummary(texts: string[], keywords: string[]): string {
  const text = texts.filter(Boolean).join(" \n ")
  const lowered = text.toLowerCase()
  for (const keyword of keywords) {
    const index = lowered.indexOf(keyword.toLowerCase())
    if (index < 0) continue
    return squash(text.slice(Math.max(0, index - 40), index + 180))
  }
  return ""
}

function summarizeStructuredResult(record: Record<string, JsonValue>): {
  textSummary: string
  stdoutSummary: string
  stderrSummary: string
  errorSummary: string
  status: string
  resultFiles: string[]
} {
  const message = asRecord(record.message)
  const toolUseResult = asRecord(record.toolUseResult)
  const content = [...asArray(record.content), ...asArray(message?.content)]

  const textParts = content.flatMap(item => {
    const block = asRecord(item)
    if (!block) return []
    if (block.type === "text" && typeof block.text === "string") return [block.text]
    if (block.type === "tool_result") {
      return asArray(block.content).map(piece => {
        const pieceRecord = asRecord(piece)
        if (pieceRecord?.type === "text" && typeof pieceRecord.text === "string") return pieceRecord.text
        return stringify(piece)
      })
    }
    return []
  })

  const stdoutSummary = squash(
    [
      typeof record.stdout === "string" ? record.stdout : "",
      typeof toolUseResult?.stdout === "string" ? (toolUseResult.stdout as string) : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
  const stderrSummary = squash(
    [
      typeof record.stderr === "string" ? record.stderr : "",
      typeof toolUseResult?.stderr === "string" ? (toolUseResult.stderr as string) : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
  const errorSummary = squash(
    [
      typeof record.error === "string" ? record.error : "",
      typeof toolUseResult?.error === "string" ? (toolUseResult.error as string) : "",
      typeof record.failure_reason === "string" ? record.failure_reason : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
  const status = squash(
    [
      typeof record.status === "string" ? record.status : "",
      typeof toolUseResult?.status === "string" ? (toolUseResult.status as string) : "",
      typeof record.result === "string" ? record.result : "",
    ]
      .filter(Boolean)
      .join(" "),
    80,
  )
  const textSummary = squash(
    [...textParts, stringify(toolUseResult?.content), stringify(record.result), status]
      .filter(Boolean)
      .join("\n"),
  )
  const resultFiles = unique(extractFiles([textSummary, stdoutSummary, stderrSummary, errorSummary].join("\n")))
  return { textSummary, stdoutSummary, stderrSummary, errorSummary, status, resultFiles }
}

function collectToolUseIds(record: Record<string, JsonValue>): string[] {
  const ids: string[] = []
  if (typeof record.tool_use_id === "string") ids.push(record.tool_use_id)
  const message = asRecord(record.message)
  for (const content of asArray(message?.content)) {
    const contentRecord = asRecord(content)
    if (typeof contentRecord?.tool_use_id === "string") ids.push(contentRecord.tool_use_id)
  }
  return unique(ids)
}

function walkSnapshot(snapshot: SnapshotRecord, node: JsonValue, collector: ToolResultCandidate[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkSnapshot(snapshot, item, collector)
    return
  }
  const record = asRecord(node)
  if (!record) return

  const toolUseIds = collectToolUseIds(record)
  const structured =
    record.type === "tool_result" ||
    typeof record.stdout === "string" ||
    typeof record.stderr === "string" ||
    typeof record.error === "string" ||
    record.toolUseResult !== undefined

  if (structured && toolUseIds.length > 0) {
    const summary = summarizeStructuredResult(record)
    for (const toolUseId of toolUseIds) {
      collector.push({
        tool_use_id: toolUseId,
        snapshot_ref: snapshot.snapshotRef,
        category: snapshot.category,
        matched_by: "tool_use_id",
        text_summary: summary.textSummary,
        stdout_summary: summary.stdoutSummary,
        stderr_summary: summary.stderrSummary,
        error_summary: summary.errorSummary,
        status: summary.status,
        result_files: summary.resultFiles,
        warnings: [],
      })
    }
  }

  for (const value of Object.values(record)) {
    walkSnapshot(snapshot, value, collector)
  }
}

function extractCandidatesFromSnapshot(snapshot: SnapshotRecord): ToolResultCandidate[] {
  const candidates: ToolResultCandidate[] = []
  walkSnapshot(snapshot, snapshot.data, candidates)
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = [
      candidate.tool_use_id ?? "null",
      candidate.snapshot_ref,
      candidate.text_summary,
      candidate.stdout_summary,
      candidate.stderr_summary,
      candidate.error_summary,
    ].join("|")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildFallbackCandidate(
  turnSnapshots: TurnSnapshotBundle,
  exactCandidates: ToolResultCandidate[],
): ToolResultCandidate | null {
  if (exactCandidates.length === 0) return null
  return {
    tool_use_id: null,
    snapshot_ref:
      turnSnapshots.afterTurnSnapshots[0]?.snapshotRef ??
      turnSnapshots.relatedSnapshots[0]?.snapshotRef ??
      "unknown",
    category:
      turnSnapshots.afterTurnSnapshots[0]?.category ??
      turnSnapshots.relatedSnapshots[0]?.category ??
      null,
    matched_by: "turn_fallback",
    text_summary: squash(exactCandidates.map(item => item.text_summary).filter(Boolean).join("\n")),
    stdout_summary: squash(exactCandidates.map(item => item.stdout_summary).filter(Boolean).join("\n")),
    stderr_summary: squash(exactCandidates.map(item => item.stderr_summary).filter(Boolean).join("\n")),
    error_summary: squash(exactCandidates.map(item => item.error_summary).filter(Boolean).join("\n")),
    status: "turn_fallback",
    result_files: unique(exactCandidates.flatMap(item => item.result_files)),
    warnings: ["after_turn result matched by turn fallback"],
  }
}

function chooseBestCandidate(candidates: ToolResultCandidate[]): ToolResultCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((left, right) => {
    const leftScore =
      (left.stdout_summary ? 4 : 0) +
      (left.stderr_summary ? 3 : 0) +
      (left.error_summary ? 5 : 0) +
      (left.text_summary ? 2 : 0) +
      (left.result_files.length > 0 ? 2 : 0)
    const rightScore =
      (right.stdout_summary ? 4 : 0) +
      (right.stderr_summary ? 3 : 0) +
      (right.error_summary ? 5 : 0) +
      (right.text_summary ? 2 : 0) +
      (right.result_files.length > 0 ? 2 : 0)
    return rightScore - leftScore
  })[0] ?? null
}

export function buildTurnToolResultIndex(
  turnSnapshotsByKey: Map<string, TurnSnapshotBundle>,
): {
  exactByTurnAndTool: Map<string, ToolResultCandidate>
  fallbackByTurn: Map<string, ToolResultCandidate>
} {
  const exactByTurnAndTool = new Map<string, ToolResultCandidate>()
  const fallbackByTurn = new Map<string, ToolResultCandidate>()
  const snapshotCache = new Map<string, ToolResultCandidate[]>()

  const cachedCandidates = (snapshot: SnapshotRecord): ToolResultCandidate[] => {
    const cached = snapshotCache.get(snapshot.snapshotRef)
    if (cached) return cached
    const extracted = extractCandidatesFromSnapshot(snapshot)
    snapshotCache.set(snapshot.snapshotRef, extracted)
    return extracted
  }

  for (const [turnKey, bundle] of turnSnapshotsByKey) {
    const perTool = new Map<string, ToolResultCandidate[]>()
    const limitedSnapshots = bundle.relatedSnapshots.slice(0, 8)
    for (const snapshot of limitedSnapshots) {
      for (const candidate of cachedCandidates(snapshot)) {
        if (!candidate.tool_use_id) continue
        const list = perTool.get(candidate.tool_use_id) ?? []
        list.push(candidate)
        perTool.set(candidate.tool_use_id, list)
      }
    }
    for (const [toolUseId, candidates] of perTool) {
      const chosen = chooseBestCandidate(candidates)
      if (chosen) exactByTurnAndTool.set(`${turnKey}|${toolUseId}`, chosen)
    }
    const fallback = buildFallbackCandidate(
      {
        ...bundle,
        relatedSnapshots: limitedSnapshots,
      },
      limitedSnapshots.flatMap(snapshot => cachedCandidates(snapshot)),
    )
    if (fallback) fallbackByTurn.set(turnKey, fallback)
  }

  return { exactByTurnAndTool, fallbackByTurn }
}

export function enrichToolCallsWithResults(params: {
  tools: RichToolCall[]
  turnSnapshotsByKey: Map<string, TurnSnapshotBundle>
}): RichToolCall[] {
  const resultIndex = buildTurnToolResultIndex(params.turnSnapshotsByKey)

  return params.tools.map(tool => {
    const turnKey = `${tool.query_id ?? "unknown"}|${tool.turn_id ?? "unknown"}`
    const exact = resultIndex.exactByTurnAndTool.get(`${turnKey}|${tool.tool_call_id}`)
    const fallback = resultIndex.fallbackByTurn.get(turnKey)
    const selected = exact ?? fallback
    const warnings = [...tool.warnings, ...(selected?.warnings ?? [])]
    const texts = [
      selected?.error_summary ?? "",
      selected?.stderr_summary ?? "",
      selected?.stdout_summary ?? "",
      selected?.text_summary ?? "",
      tool.output_summary,
      tool.input_summary,
      tool.prompt_summary,
    ]
    const detectedProblem = findKeywordSummary(texts, PROBLEM_KEYWORDS)
    const detectedFixSignal = findKeywordSummary(texts, FIX_KEYWORDS)
    const outputHints = findKeywordSummary(texts, FILE_HINT_KEYWORDS)
    const resultFiles = unique([
      ...tool.produced_files,
      ...(selected?.result_files ?? []),
      ...extractFiles(
        [selected?.text_summary, selected?.stdout_summary, selected?.stderr_summary, outputHints]
          .filter(Boolean)
          .join("\n"),
      ),
    ])

    const richSummary = squash(
      [
        selected?.error_summary ? `error: ${selected.error_summary}` : "",
        selected?.stderr_summary ? `stderr: ${selected.stderr_summary}` : "",
        selected?.stdout_summary ? `stdout: ${selected.stdout_summary}` : "",
        selected?.text_summary ? `result: ${selected.text_summary}` : "",
        !selected && tool.output_summary ? tool.output_summary : "",
      ]
        .filter(Boolean)
        .join(" | "),
      320,
    )

    return {
      ...tool,
      output_summary: richSummary || tool.output_summary,
      stdout_summary: selected?.stdout_summary ?? "",
      stderr_summary: selected?.stderr_summary ?? "",
      error_summary: selected?.error_summary ?? "",
      result_summary_rich: richSummary || tool.output_summary,
      detected_problem: detectedProblem,
      detected_fix_signal: detectedFixSignal,
      result_files: resultFiles,
      produced_files: unique([...tool.produced_files, ...resultFiles]),
      evidence_refs: unique([...tool.evidence_refs, ...(selected?.snapshot_ref ? [selected.snapshot_ref] : [])]),
      snapshot_refs: unique([...tool.snapshot_refs, ...(selected?.snapshot_ref ? [selected.snapshot_ref] : [])]),
      warnings,
    }
  })
}
