import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join, relative, resolve } from "node:path"

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type EventRecord = {
  schema_version?: string
  ts_wall: string
  ts_mono_ms?: number | null
  level?: string | null
  event: string
  component?: string | null
  session_id?: string | null
  conversation_id?: string | null
  user_action_id?: string | null
  query_id?: string | null
  turn_id?: string | null
  loop_iter?: number | null
  parent_turn_id?: string | null
  subagent_id?: string | null
  subagent_type?: string | null
  subagent_reason?: string | null
  subagent_trigger_kind?: string | null
  subagent_trigger_detail?: string | null
  query_source?: string | null
  request_id?: string | null
  tool_call_id?: string | null
  span_id?: string | null
  parent_span_id?: string | null
  cwd?: string | null
  git_branch?: string | null
  build_version?: string | null
  payload?: Record<string, JsonValue> | null
}

type QuerySpan = {
  queryId: string
  userActionId: string | null
  querySource: string | null
  subagentId: string | null
  startMs: number
  endMs: number
}

type SnapshotInfo = {
  snapshotRef: string
  fileName: string
  relativePath: string
  absolutePath: string
  exists: boolean
  sizeBytes: number | null
  sha256: string | null
  referencedCount: number
  firstEventTs: string | null
  lastEventTs: string | null
  category: string | null
}

type UsageFact = {
  usage_fact_id: string
  event_date: string
  ts_wall: string
  ts_wall_ms: number | null
  user_action_id: string | null
  query_id: string | null
  query_source: string | null
  subagent_id: string | null
  subagent_reason: string | null
  agent_name: string | null
  source_group: string | null
  source_kind: string
  source_ref: string | null
  request_id: string | null
  assistant_message_count: number | null
  is_authoritative: boolean
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_prompt_input_tokens: number
  total_billed_tokens: number
}

const repoRoot = resolve(import.meta.dir, "..", "..")
const observabilityDir = join(repoRoot, ".observability")
const snapshotsDir = join(observabilityDir, "snapshots")
const duckdbExe = join(repoRoot, "tools", "duckdb", "duckdb.exe")
const databasePath = join(observabilityDir, "observability_v1.duckdb")
const sqlPath = join(observabilityDir, "load_observability_v1.sql")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv: string[]): { eventsFile?: string; date?: string } {
  const parsed: { eventsFile?: string; date?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === "--events-file") {
      parsed.eventsFile = argv[index + 1]
      index += 1
      continue
    }
    if (current === "--date") {
      parsed.date = argv[index + 1]
      index += 1
    }
  }
  return parsed
}

function resolveEventsPath(args: { eventsFile?: string; date?: string }): string {
  if (args.eventsFile) {
    return resolve(args.eventsFile)
  }

  const files = readdirSync(observabilityDir)
    .filter(fileName => /^events-\d{8}\.jsonl$/u.test(fileName))
    .sort()

  if (files.length === 0) {
    fail(`No events-YYYYMMDD.jsonl files found in ${observabilityDir}`)
  }

  if (args.date) {
    const normalizedDate = args.date.replace(/-/gu, "")
    const fileName = `events-${normalizedDate}.jsonl`
    const matched = files.find(candidate => candidate === fileName)
    if (!matched) {
      fail(`Requested events file not found for date ${args.date}`)
    }
    return join(observabilityDir, matched)
  }

  return join(observabilityDir, files.at(-1)!)
}

function parseConcatenatedEvents(text: string): EventRecord[] {
  const values: EventRecord[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index]!)) {
      index += 1
    }
    if (index >= text.length) {
      break
    }
    const { object, nextIndex } = readOneObject(text, index)
    values.push(object as EventRecord)
    index = nextIndex
  }
  return values
}

function readOneObject(text: string, startIndex: number): { object: JsonValue; nextIndex: number } {
  let depth = 0
  let inString = false
  let escaped = false
  let index = startIndex

  for (; index < text.length; index += 1) {
    const char = text[index]!

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return {
          object: JSON.parse(text.slice(startIndex, index + 1)) as JsonValue,
          nextIndex: index + 1,
        }
      }
    }
  }

  throw new Error(`Unterminated JSON object at index ${startIndex}`)
}

function toEpochMs(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL"
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL"
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE"
  }
  const normalized = String(value).replace(/'/g, "''")
  return `'${normalized}'`
}

function compactJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return JSON.stringify(value)
}

function jsonPathToAbsolute(snapshotRef: string): string {
  return join(repoRoot, ...snapshotRef.split("/"))
}

function collectSnapshotRefs(value: JsonValue, refs: Set<string>): void {
  if (typeof value === "string" && value.startsWith(".observability/snapshots/")) {
    refs.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSnapshotRefs(item, refs)
    }
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectSnapshotRefs(item, refs)
    }
  }
}

function buildExplicitQuerySpans(events: EventRecord[]): QuerySpan[] {
  const spans = new Map<string, QuerySpan>()

  for (const event of events) {
    if (!event.query_id) {
      continue
    }
    const tsMs = toEpochMs(event.ts_wall)
    if (tsMs === null) {
      continue
    }
    const existing = spans.get(event.query_id)
    if (existing) {
      existing.startMs = Math.min(existing.startMs, tsMs)
      existing.endMs = Math.max(existing.endMs, tsMs)
      existing.userActionId ||= event.user_action_id ?? null
      existing.querySource ||= event.query_source ?? null
      existing.subagentId ||= event.subagent_id ?? null
      continue
    }
    spans.set(event.query_id, {
      queryId: event.query_id,
      userActionId: event.user_action_id ?? null,
      querySource: event.query_source ?? null,
      subagentId: event.subagent_id ?? null,
      startMs: tsMs,
      endMs: tsMs,
    })
  }

  return [...spans.values()]
}

function resolveEffectiveQueryId(event: EventRecord, spans: QuerySpan[]): string | null {
  if (event.query_id) {
    return event.query_id
  }
  const tsMs = toEpochMs(event.ts_wall)
  if (tsMs === null || !event.user_action_id) {
    return null
  }

  const matches = spans.filter(span => {
    if (span.userActionId !== event.user_action_id) {
      return false
    }
    if (event.query_source && span.querySource && span.querySource !== event.query_source) {
      return false
    }
    if (event.subagent_id && span.subagentId && span.subagentId !== event.subagent_id) {
      return false
    }
    return tsMs >= span.startMs - 5_000 && tsMs <= span.endMs + 5_000
  })

  if (matches.length === 0) {
    return null
  }
  if (matches.length === 1) {
    return matches[0]!.queryId
  }

  matches.sort((left, right) => {
    const leftDistance = Math.min(Math.abs(tsMs - left.startMs), Math.abs(tsMs - left.endMs))
    const rightDistance = Math.min(Math.abs(tsMs - right.startMs), Math.abs(tsMs - right.endMs))
    return leftDistance - rightDistance
  })

  return matches[0]!.queryId
}

function sha256Hex(path: string): string {
  const hash = createHash("sha256")
  hash.update(readFileSync(path))
  return hash.digest("hex")
}

function snapshotCategory(fileName: string): string | null {
  const lowered = fileName.toLowerCase()
  if (lowered.includes("request")) return "request"
  if (lowered.includes("response")) return "response"
  if (lowered.includes("state.snapshot.before_turn")) return "state_before_turn"
  if (lowered.includes("state.snapshot.after_turn")) return "state_after_turn"
  if (lowered.includes("state-before")) return "state_before"
  if (lowered.includes("state-after")) return "state_after"
  if (lowered.includes("input-raw")) return "input_raw"
  if (lowered.includes("input-messages")) return "input_messages"
  if (lowered.includes("messages.")) return "messages_stage"
  return null
}

function inferString(value: JsonValue | undefined, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const current = value[key]
  return typeof current === "string" ? current : null
}

function inferNumber(value: JsonValue | undefined, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const current = value[key]
  return typeof current === "number" ? current : null
}

function inferBoolean(value: JsonValue | undefined, key: string): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const current = value[key]
  return typeof current === "boolean" ? current : null
}

function inferObject(
  value: JsonValue | undefined,
  key: string,
): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const current = value[key]
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return null
  }
  return current as Record<string, JsonValue>
}

function resolveSubagentReason(event: EventRecord): string | null {
  const resolved =
    event.subagent_reason ??
    inferString(event.payload, "subagent_reason") ??
    event.subagent_type ??
    event.query_source ??
    "unknown"
  return resolved === "side_question" ? "side_query" : resolved
}

function resolveSubagentTriggerKind(event: EventRecord): string | null {
  return (
    event.subagent_trigger_kind ??
    inferString(event.payload, "subagent_trigger_kind") ??
    null
  )
}

function resolveSubagentTriggerDetail(event: EventRecord): string | null {
  return (
    event.subagent_trigger_detail ??
    inferString(event.payload, "subagent_trigger_detail") ??
    null
  )
}

function resolveSubagentTriggerPayload(
  event: EventRecord,
): Record<string, JsonValue> | null {
  return inferObject(event.payload, "subagent_trigger_payload")
}

function normalizeAgentName(
  querySource: string | null | undefined,
  subagentType: string | null | undefined,
  subagentReason: string | null | undefined,
): string | null {
  const candidate = subagentReason ?? subagentType ?? querySource
  if (!candidate) {
    return null
  }
  if (candidate === "side_question") {
    return "side_query"
  }
  if (candidate.startsWith("repl_main_thread")) {
    return "main_thread"
  }
  if (candidate.startsWith("agent:builtin:")) {
    return candidate.slice("agent:builtin:".length)
  }
  if (candidate === "agent:custom") {
    return "custom_agent"
  }
  return candidate
}

function normalizeSourceGroup(
  querySource: string | null | undefined,
  subagentId: string | null | undefined,
  agentName: string | null | undefined,
): string | null {
  if (!agentName && !querySource) {
    return null
  }
  if (agentName === "main_thread" || querySource?.startsWith("repl_main_thread")) {
    return "main_thread"
  }
  if (
    agentName &&
    [
      "extract_memories",
      "session_memory",
      "session_search",
      "away_summary",
      "agent_summary",
      "memdir_relevance",
    ].includes(agentName)
  ) {
    return "memory"
  }
  if (
    agentName &&
    [
      "side_query",
      "permission_explainer",
      "model_validation",
      "session_search",
    ].includes(agentName)
  ) {
    return "side_query"
  }
  if (querySource?.startsWith("agent:") || agentName === "custom_agent") {
    return "agent"
  }
  if (subagentId) {
    return "subagent"
  }
  return "other"
}

function createInsertSql(
  tableName: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  if (rows.length === 0) {
    return ""
  }
  const values = rows
    .map(row => `(${columns.map(column => sqlLiteral(row[column])).join(", ")})`)
    .join(",\n")
  return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n${values};\n`
}

function extractResponseUsage(snapshotRef: string): {
  requestId: string | null
  assistantMessageCount: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
} | null {
  const absolutePath = jsonPathToAbsolute(snapshotRef)
  if (!existsSync(absolutePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as {
      assistantMessages?: Array<{
        message?: {
          id?: string
          usage?: Record<string, unknown>
        }
      }>
    }
    const assistantMessages = parsed.assistantMessages ?? []
    let requestId: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadInputTokens = 0
    let cacheCreationInputTokens = 0

    for (const assistantMessage of assistantMessages) {
      const message = assistantMessage.message
      if (!message) {
        continue
      }
      requestId ||= typeof message.id === "string" ? message.id : null
      const usage = message.usage ?? {}
      inputTokens = Math.max(inputTokens, toNumber(usage.input_tokens))
      outputTokens = Math.max(outputTokens, toNumber(usage.output_tokens))
      cacheReadInputTokens = Math.max(
        cacheReadInputTokens,
        toNumber(usage.cache_read_input_tokens),
      )
      cacheCreationInputTokens = Math.max(
        cacheCreationInputTokens,
        toNumber(usage.cache_creation_input_tokens),
      )
    }

    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadInputTokens === 0 &&
      cacheCreationInputTokens === 0
    ) {
      return null
    }

    return {
      requestId,
      assistantMessageCount: assistantMessages.length,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    }
  } catch {
    return null
  }
}

if (!existsSync(duckdbExe)) {
  fail(`DuckDB executable not found: ${duckdbExe}`)
}

mkdirSync(observabilityDir, { recursive: true })

const args = parseArgs(process.argv.slice(2))
const eventsPath = resolveEventsPath(args)
if (!existsSync(eventsPath)) {
  fail(`Events file not found: ${eventsPath}`)
}

const eventsFileStat = statSync(eventsPath)
const events = parseConcatenatedEvents(readFileSync(eventsPath, "utf8"))
const querySpans = buildExplicitQuerySpans(events)
const effectiveQueryIds = events.map(event => resolveEffectiveQueryId(event, querySpans))

const referencedSnapshots = new Map<string, SnapshotInfo>()
const perEventSnapshotRefs: string[][] = []

for (const [index, event] of events.entries()) {
  const refs = new Set<string>()
  collectSnapshotRefs(event as unknown as JsonValue, refs)
  const orderedRefs = [...refs].sort()
  perEventSnapshotRefs.push(orderedRefs)

  for (const snapshotRef of orderedRefs) {
    const fileName = snapshotRef.split("/").at(-1) ?? snapshotRef
    const absolutePath = jsonPathToAbsolute(snapshotRef)
    const stat = existsSync(absolutePath) ? statSync(absolutePath) : null
    const existing = referencedSnapshots.get(snapshotRef)
    if (existing) {
      existing.referencedCount += 1
      existing.firstEventTs ||= event.ts_wall
      existing.lastEventTs = event.ts_wall
      continue
    }
    referencedSnapshots.set(snapshotRef, {
      snapshotRef,
      fileName,
      relativePath: snapshotRef,
      absolutePath,
      exists: stat !== null,
      sizeBytes: stat?.size ?? null,
      sha256: stat ? sha256Hex(absolutePath) : null,
      referencedCount: 1,
      firstEventTs: event.ts_wall,
      lastEventTs: event.ts_wall,
      category: snapshotCategory(fileName),
    })
  }

  void index
}

const snapshotFiles = existsSync(snapshotsDir) ? readdirSync(snapshotsDir) : []
for (const fileName of snapshotFiles) {
  const snapshotRef = `.observability/snapshots/${fileName}`
  if (referencedSnapshots.has(snapshotRef)) {
    continue
  }
  const absolutePath = join(snapshotsDir, fileName)
  const stat = statSync(absolutePath)
  referencedSnapshots.set(snapshotRef, {
    snapshotRef,
    fileName,
    relativePath: relative(repoRoot, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    exists: true,
    sizeBytes: stat.size,
    sha256: sha256Hex(absolutePath),
    referencedCount: 0,
    firstEventTs: null,
    lastEventTs: null,
    category: snapshotCategory(fileName),
  })
}

const subagentCompletedQueryIds = new Set(
  events
    .filter(event => event.event === "subagent.completed" && event.query_id)
    .map(event => event.query_id!) as string[],
)

const usageFacts: UsageFact[] = []

for (const [index, event] of events.entries()) {
  if (event.event !== "api.stream.completed") {
    continue
  }
  const responseSnapshotRef = inferString(event.payload, "response_snapshot_ref")
  if (!responseSnapshotRef) {
    continue
  }
  const usage = extractResponseUsage(responseSnapshotRef)
  if (!usage) {
    continue
  }

  const effectiveQueryId = effectiveQueryIds[index] ?? event.query_id ?? null
  const subagentReason = resolveSubagentReason(event)
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )
  const sourceGroup = normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    agentName,
  )
  const isAuthoritative =
    agentName === "main_thread" ||
    !subagentCompletedQueryIds.has(effectiveQueryId ?? "__missing__")

  usageFacts.push({
    usage_fact_id: `response::${responseSnapshotRef}`,
    event_date: event.ts_wall.slice(0, 10),
    ts_wall: event.ts_wall,
    ts_wall_ms: toEpochMs(event.ts_wall),
    user_action_id: event.user_action_id ?? null,
    query_id: effectiveQueryId,
    query_source: event.query_source ?? null,
    subagent_id: event.subagent_id ?? null,
    subagent_reason: subagentReason,
    agent_name: agentName,
    source_group: sourceGroup,
    source_kind: "response_snapshot",
    source_ref: responseSnapshotRef,
    request_id: usage.requestId,
    assistant_message_count: usage.assistantMessageCount,
    is_authoritative: isAuthoritative,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    total_prompt_input_tokens:
      usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens,
    total_billed_tokens:
      usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens +
      usage.outputTokens,
  })
}

for (const [index, event] of events.entries()) {
  if (event.event !== "subagent.completed") {
    continue
  }
  const inputTokens = inferNumber(event.payload, "input_tokens") ?? 0
  const outputTokens = inferNumber(event.payload, "output_tokens") ?? 0
  const cacheReadInputTokens = inferNumber(event.payload, "cache_read_input_tokens") ?? 0
  const cacheCreationInputTokens =
    inferNumber(event.payload, "cache_creation_input_tokens") ?? 0
  const subagentReason = resolveSubagentReason(event)
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )
  const sourceGroup = normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    agentName,
  )

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0
  ) {
    continue
  }

  usageFacts.push({
    usage_fact_id: `subagent_completed::${event.subagent_id ?? index}`,
    event_date: event.ts_wall.slice(0, 10),
    ts_wall: event.ts_wall,
    ts_wall_ms: toEpochMs(event.ts_wall),
    user_action_id: event.user_action_id ?? null,
    query_id: event.query_id ?? effectiveQueryIds[index],
    query_source: event.query_source ?? null,
    subagent_id: event.subagent_id ?? null,
    subagent_reason: subagentReason,
    agent_name: agentName,
    source_group: sourceGroup,
    source_kind: "subagent_completed_payload",
    source_ref: `${event.event}:${index + 1}`,
    request_id: null,
    assistant_message_count: inferNumber(event.payload, "message_count"),
    is_authoritative: true,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    total_prompt_input_tokens:
      inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    total_billed_tokens:
      inputTokens +
      cacheReadInputTokens +
      cacheCreationInputTokens +
      outputTokens,
  })
}

const queryRows = new Map<string, Record<string, unknown>>()

for (const [index, event] of events.entries()) {
  const effectiveQueryId = effectiveQueryIds[index]
  if (!effectiveQueryId) {
    continue
  }
  const subagentReason = resolveSubagentReason(event)
  const subagentTriggerKind = resolveSubagentTriggerKind(event)
  const subagentTriggerDetail = resolveSubagentTriggerDetail(event)
  const subagentTriggerPayloadJson = compactJson(resolveSubagentTriggerPayload(event))
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )
  const sourceGroup = normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    agentName,
  )
  const tsMs = toEpochMs(event.ts_wall)
  if (tsMs === null) {
    continue
  }
  const existing = queryRows.get(effectiveQueryId) ?? {
    query_id: effectiveQueryId,
    user_action_id: event.user_action_id ?? null,
    session_id: event.session_id ?? null,
    conversation_id: event.conversation_id ?? null,
    query_source: event.query_source ?? null,
    subagent_id: event.subagent_id ?? null,
    subagent_type: event.subagent_type ?? null,
    subagent_reason: subagentReason,
    subagent_trigger_kind: subagentTriggerKind,
    subagent_trigger_detail: subagentTriggerDetail,
    subagent_trigger_payload_json: subagentTriggerPayloadJson,
    agent_name: agentName,
    source_group: sourceGroup,
    started_at: event.ts_wall,
    started_at_ms: tsMs,
    ended_at: event.ts_wall,
    ended_at_ms: tsMs,
    first_event: event.event,
    last_event: event.event,
    terminal_reason: null,
    stop_reason: null,
    turn_ids: new Set<string>(),
    tool_call_ids: new Set<string>(),
    event_count: 0,
    raw_query_started_count: 0,
    raw_query_terminated_count: 0,
    inferred_query_started_count: 0,
    inferred_query_terminated_count: 0,
  }

  existing.user_action_id ||= event.user_action_id ?? null
  existing.session_id ||= event.session_id ?? null
  existing.conversation_id ||= event.conversation_id ?? null
  existing.query_source ||= event.query_source ?? null
  existing.subagent_id ||= event.subagent_id ?? null
  existing.subagent_type ||= event.subagent_type ?? null
  existing.subagent_reason ||= subagentReason
  existing.subagent_trigger_kind ||= subagentTriggerKind
  existing.subagent_trigger_detail ||= subagentTriggerDetail
  existing.subagent_trigger_payload_json ||= subagentTriggerPayloadJson
  existing.agent_name ||= agentName
  existing.source_group ||= sourceGroup
  existing.event_count = Number(existing.event_count) + 1

  if (tsMs < Number(existing.started_at_ms)) {
    existing.started_at = event.ts_wall
    existing.started_at_ms = tsMs
    existing.first_event = event.event
  }
  if (tsMs >= Number(existing.ended_at_ms)) {
    existing.ended_at = event.ts_wall
    existing.ended_at_ms = tsMs
    existing.last_event = event.event
  }

  if (event.turn_id) {
    ;(existing.turn_ids as Set<string>).add(event.turn_id)
  }
  if (event.tool_call_id) {
    ;(existing.tool_call_ids as Set<string>).add(event.tool_call_id)
  }

  if (event.event === "query.started") {
    existing.inferred_query_started_count = Number(existing.inferred_query_started_count) + 1
    if (event.query_id === effectiveQueryId) {
      existing.raw_query_started_count = Number(existing.raw_query_started_count) + 1
    }
  }
  if (event.event === "query.terminated") {
    existing.inferred_query_terminated_count =
      Number(existing.inferred_query_terminated_count) + 1
    existing.terminal_reason = inferString(event.payload, "reason")
    if (event.query_id === effectiveQueryId) {
      existing.raw_query_terminated_count = Number(existing.raw_query_terminated_count) + 1
    }
  }
  if (event.event === "api.stream.completed") {
    existing.stop_reason = inferString(event.payload, "stop_reason")
  }

  queryRows.set(effectiveQueryId, existing)
}

const turnRows = new Map<string, Record<string, unknown>>()

for (const [index, event] of events.entries()) {
  if (!event.turn_id) {
    continue
  }
  const effectiveQueryId = effectiveQueryIds[index]
  if (!effectiveQueryId) {
    continue
  }
  const subagentReason = resolveSubagentReason(event)
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )
  const sourceGroup = normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    agentName,
  )
  const turnKey = `${effectiveQueryId}::${event.turn_id}`
  const tsMs = toEpochMs(event.ts_wall)
  if (tsMs === null) {
    continue
  }
  const existing = turnRows.get(turnKey) ?? {
    turn_key: turnKey,
    query_id: effectiveQueryId,
    turn_id: event.turn_id,
    user_action_id: event.user_action_id ?? null,
    subagent_id: event.subagent_id ?? null,
    query_source: event.query_source ?? null,
    subagent_reason: subagentReason,
    agent_name: agentName,
    source_group: sourceGroup,
    loop_iter_start: event.loop_iter ?? null,
    loop_iter_end: event.loop_iter ?? null,
    started_at: event.ts_wall,
    started_at_ms: tsMs,
    ended_at: event.ts_wall,
    ended_at_ms: tsMs,
    first_event: event.event,
    last_event: event.event,
    transition_out: null,
    termination_reason: null,
    stop_reason: null,
    assistant_tool_use_count: 0,
    event_count: 0,
    tool_call_ids: new Set<string>(),
    raw_turn_started_count: 0,
    raw_state_before_count: 0,
    raw_state_after_count: 0,
    inferred_turn_started_count: 0,
    inferred_state_before_count: 0,
    inferred_state_after_count: 0,
  }

  existing.user_action_id ||= event.user_action_id ?? null
  existing.subagent_id ||= event.subagent_id ?? null
  existing.query_source ||= event.query_source ?? null
  existing.subagent_reason ||= subagentReason
  existing.agent_name ||= agentName
  existing.source_group ||= sourceGroup

  if (event.loop_iter !== null && event.loop_iter !== undefined) {
    if (
      existing.loop_iter_start === null ||
      Number(event.loop_iter) < Number(existing.loop_iter_start)
    ) {
      existing.loop_iter_start = event.loop_iter
    }
    if (
      existing.loop_iter_end === null ||
      Number(event.loop_iter) > Number(existing.loop_iter_end)
    ) {
      existing.loop_iter_end = event.loop_iter
    }
  }

  existing.event_count = Number(existing.event_count) + 1

  if (tsMs < Number(existing.started_at_ms)) {
    existing.started_at = event.ts_wall
    existing.started_at_ms = tsMs
    existing.first_event = event.event
  }
  if (tsMs >= Number(existing.ended_at_ms)) {
    existing.ended_at = event.ts_wall
    existing.ended_at_ms = tsMs
    existing.last_event = event.event
  }

  if (event.tool_call_id) {
    ;(existing.tool_call_ids as Set<string>).add(event.tool_call_id)
  }

  if (event.event === "turn.started") {
    existing.inferred_turn_started_count = Number(existing.inferred_turn_started_count) + 1
    if (event.query_id === effectiveQueryId) {
      existing.raw_turn_started_count = Number(existing.raw_turn_started_count) + 1
    }
  }
  if (event.event === "state.snapshot.before_turn") {
    existing.inferred_state_before_count = Number(existing.inferred_state_before_count) + 1
    if (event.query_id === effectiveQueryId) {
      existing.raw_state_before_count = Number(existing.raw_state_before_count) + 1
    }
  }
  if (event.event === "state.snapshot.after_turn") {
    existing.inferred_state_after_count = Number(existing.inferred_state_after_count) + 1
    if (event.query_id === effectiveQueryId) {
      existing.raw_state_after_count = Number(existing.raw_state_after_count) + 1
    }
  }
  if (event.event === "assistant.tool_use.detected") {
    existing.assistant_tool_use_count = Number(existing.assistant_tool_use_count) + 1
  }
  if (event.event === "state.transitioned") {
    existing.transition_out = inferString(event.payload, "to_transition")
  }
  if (event.event === "query.terminated") {
    existing.termination_reason = inferString(event.payload, "reason")
  }
  if (event.event === "api.stream.completed") {
    existing.stop_reason = inferString(event.payload, "stop_reason")
  }

  turnRows.set(turnKey, existing)
}

const toolRows = new Map<string, Record<string, unknown>>()

for (const [index, event] of events.entries()) {
  if (!event.tool_call_id) {
    continue
  }

  const existing = toolRows.get(event.tool_call_id) ?? {
    tool_call_id: event.tool_call_id,
    user_action_id: event.user_action_id ?? null,
    query_id: effectiveQueryIds[index] ?? event.query_id ?? null,
    turn_id: event.turn_id ?? null,
    subagent_id: event.subagent_id ?? null,
    tool_name: inferString(event.payload, "tool_name"),
    execution_mode: null,
    detected_at: null,
    detected_at_ms: null,
    enqueued_at: null,
    enqueued_at_ms: null,
    started_at: null,
    started_at_ms: null,
    completed_at: null,
    completed_at_ms: null,
    duration_ms: null,
    success: null,
    failure_reason: null,
    event_count: 0,
    has_tool_use_detected: false,
    has_started: false,
    has_completed: false,
    has_failed: false,
  }

  existing.user_action_id ||= event.user_action_id ?? null
  existing.query_id ||= effectiveQueryIds[index] ?? event.query_id ?? null
  existing.turn_id ||= event.turn_id ?? null
  existing.subagent_id ||= event.subagent_id ?? null
  existing.tool_name ||= inferString(event.payload, "tool_name")
  existing.event_count = Number(existing.event_count) + 1

  const tsMs = toEpochMs(event.ts_wall)

  if (event.event === "assistant.tool_use.detected") {
    existing.detected_at = event.ts_wall
    existing.detected_at_ms = tsMs
    existing.has_tool_use_detected = true
  }
  if (event.event === "tool.enqueued") {
    existing.enqueued_at = event.ts_wall
    existing.enqueued_at_ms = tsMs
  }
  if (event.event === "tool.execution.started") {
    existing.started_at = event.ts_wall
    existing.started_at_ms = tsMs
    existing.has_started = true
  }
  if (event.event === "tool.execution.completed") {
    existing.completed_at = event.ts_wall
    existing.completed_at_ms = tsMs
    existing.duration_ms = inferNumber(event.payload, "duration_ms")
    existing.success = inferBoolean(event.payload, "success")
    existing.has_completed = true
  }
  if (event.event === "tool.execution.failed") {
    existing.completed_at = event.ts_wall
    existing.completed_at_ms = tsMs
    existing.duration_ms = inferNumber(event.payload, "duration_ms")
    existing.success = false
    existing.failure_reason =
      inferString(event.payload, "error_name") ?? inferString(event.payload, "error")
    existing.has_failed = true
  }

  toolRows.set(event.tool_call_id, existing)
}

const subagentRows = new Map<string, Record<string, unknown>>()

for (const event of events) {
  if (
    event.event !== "subagent.spawned" &&
    event.event !== "subagent.completed" &&
    event.event !== "subagent.message.received"
  ) {
    continue
  }
  const key = event.subagent_id
  if (!key) {
    continue
  }
  const subagentReason = resolveSubagentReason(event)
  const subagentTriggerKind = resolveSubagentTriggerKind(event)
  const subagentTriggerDetail = resolveSubagentTriggerDetail(event)
  const subagentTriggerPayloadJson = compactJson(resolveSubagentTriggerPayload(event))
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )

  const existing = subagentRows.get(key) ?? {
    subagent_id: key,
    query_id: event.query_id ?? null,
    user_action_id: event.user_action_id ?? null,
    subagent_type: event.subagent_type ?? null,
    subagent_reason: subagentReason,
    subagent_trigger_kind: subagentTriggerKind,
    subagent_trigger_detail: subagentTriggerDetail,
    subagent_trigger_payload_json: subagentTriggerPayloadJson,
    query_source: event.query_source ?? null,
    agent_name: agentName,
    source_group: normalizeSourceGroup(
      event.query_source ?? null,
      event.subagent_id ?? null,
      agentName,
    ),
    spawned_at: null,
    spawned_at_ms: null,
    completed_at: null,
    completed_at_ms: null,
    duration_ms: null,
    transcript_enabled: null,
    inherited_message_count: null,
    prompt_message_count: null,
    message_event_count: 0,
    has_spawned: false,
    has_completed: false,
  }

  existing.query_id ||= event.query_id ?? null
  existing.user_action_id ||= event.user_action_id ?? null
  existing.subagent_type ||= event.subagent_type ?? null
  existing.query_source ||= event.query_source ?? null
  existing.subagent_reason ||= subagentReason
  existing.subagent_trigger_kind ||= subagentTriggerKind
  existing.subagent_trigger_detail ||= subagentTriggerDetail
  existing.subagent_trigger_payload_json ||= subagentTriggerPayloadJson
  existing.agent_name ||= agentName
  existing.source_group ||= normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    existing.agent_name as string | null,
  )

  if (event.event === "subagent.spawned") {
    existing.spawned_at = event.ts_wall
    existing.spawned_at_ms = toEpochMs(event.ts_wall)
    existing.transcript_enabled = inferBoolean(event.payload, "transcript_enabled")
    existing.inherited_message_count = inferNumber(event.payload, "inherited_message_count")
    existing.prompt_message_count = inferNumber(event.payload, "prompt_message_count")
    existing.has_spawned = true
  }

  if (event.event === "subagent.completed") {
    existing.completed_at = event.ts_wall
    existing.completed_at_ms = toEpochMs(event.ts_wall)
    existing.duration_ms =
      inferNumber(event.payload, "duration_ms") ??
      (existing.spawned_at_ms !== null && existing.completed_at_ms !== null
        ? Number(existing.completed_at_ms) - Number(existing.spawned_at_ms)
        : null)
    existing.has_completed = true
  }

  if (event.event === "subagent.message.received") {
    existing.message_event_count = Number(existing.message_event_count) + 1
  }

  subagentRows.set(key, existing)
}

const recoveryRows: Record<string, unknown>[] = []
for (const [index, event] of events.entries()) {
  const transition = inferString(event.payload, "to_transition")
  const reason = inferString(event.payload, "reason")
  const isRecoveryEvent =
    event.event.includes("recovery") ||
    event.event.includes("stop_hooks") ||
    event.event.includes("error") ||
    event.event.includes("failed") ||
    (event.event === "state.transitioned" && transition !== null && transition !== "next_turn")

  if (!isRecoveryEvent) {
    continue
  }

  recoveryRows.push({
    recovery_key: `${event.event}::${index + 1}`,
    event_name: event.event,
    user_action_id: event.user_action_id ?? null,
    query_id: effectiveQueryIds[index] ?? event.query_id ?? null,
    turn_id: event.turn_id ?? null,
    subagent_id: event.subagent_id ?? null,
    ts_wall: event.ts_wall,
    ts_wall_ms: toEpochMs(event.ts_wall),
    transition_to: transition,
    reason,
    payload_json: compactJson(event.payload),
  })
}

const dailyRollups = new Map<string, Record<string, unknown>>()

for (const [index, event] of events.entries()) {
  const eventDate = event.ts_wall.slice(0, 10)
  const existing = dailyRollups.get(eventDate) ?? {
    event_date: eventDate,
    event_count: 0,
    user_action_ids: new Set<string>(),
    query_ids: new Set<string>(),
    turn_keys: new Set<string>(),
    tool_call_ids: new Set<string>(),
    subagent_ids: new Set<string>(),
    snapshot_refs: new Set<string>(),
    latest_event_ts: event.ts_wall,
  }

  existing.event_count = Number(existing.event_count) + 1
  if (event.user_action_id) {
    ;(existing.user_action_ids as Set<string>).add(event.user_action_id)
  }
  const effectiveQueryId = effectiveQueryIds[index]
  if (effectiveQueryId) {
    ;(existing.query_ids as Set<string>).add(effectiveQueryId)
  }
  if (effectiveQueryId && event.turn_id) {
    ;(existing.turn_keys as Set<string>).add(`${effectiveQueryId}::${event.turn_id}`)
  }
  if (event.tool_call_id) {
    ;(existing.tool_call_ids as Set<string>).add(event.tool_call_id)
  }
  if (event.subagent_id) {
    ;(existing.subagent_ids as Set<string>).add(event.subagent_id)
  }
  for (const snapshotRef of perEventSnapshotRefs[index] ?? []) {
    ;(existing.snapshot_refs as Set<string>).add(snapshotRef)
  }
  existing.latest_event_ts = event.ts_wall
  dailyRollups.set(eventDate, existing)
}

const eventsRawRows = events.map((event, index) => {
  const subagentReason = resolveSubagentReason(event)
  const subagentTriggerKind = resolveSubagentTriggerKind(event)
  const subagentTriggerDetail = resolveSubagentTriggerDetail(event)
  const subagentTriggerPayloadJson = compactJson(resolveSubagentTriggerPayload(event))
  const agentName = normalizeAgentName(
    event.query_source ?? null,
    event.subagent_type ?? null,
    subagentReason,
  )
  const sourceGroup = normalizeSourceGroup(
    event.query_source ?? null,
    event.subagent_id ?? null,
    agentName,
  )
  return {
    event_idx: index + 1,
    schema_version: event.schema_version ?? null,
    event_date: event.ts_wall.slice(0, 10),
    ts_wall: event.ts_wall,
    ts_wall_ms: toEpochMs(event.ts_wall),
    ts_mono_ms: event.ts_mono_ms ?? null,
    level: event.level ?? null,
    event_name: event.event,
    component: event.component ?? null,
    session_id: event.session_id ?? null,
    conversation_id: event.conversation_id ?? null,
    user_action_id: event.user_action_id ?? null,
    query_id: event.query_id ?? null,
    effective_query_id: effectiveQueryIds[index],
    turn_id: event.turn_id ?? null,
    loop_iter: event.loop_iter ?? null,
    parent_turn_id: event.parent_turn_id ?? null,
    subagent_id: event.subagent_id ?? null,
    subagent_type: event.subagent_type ?? null,
    subagent_reason: subagentReason,
    subagent_trigger_kind: subagentTriggerKind,
    subagent_trigger_detail: subagentTriggerDetail,
    subagent_trigger_payload_json: subagentTriggerPayloadJson,
    agent_name: agentName,
    source_group: sourceGroup,
    query_source: event.query_source ?? null,
    request_id: event.request_id ?? null,
    tool_call_id: event.tool_call_id ?? null,
    span_id: event.span_id ?? null,
    parent_span_id: event.parent_span_id ?? null,
    cwd: event.cwd ?? null,
    git_branch: event.git_branch ?? null,
    build_version: event.build_version ?? null,
    payload_json: compactJson(event.payload),
    snapshot_refs_json: compactJson(perEventSnapshotRefs[index] ?? []),
    raw_event_json: compactJson(event),
  }
})

const queryLoopStats = new Map<
  string,
  {
    maxLoopIter: number | null
    totalLoopIter: number
    loopIterCount: number
  }
>()

for (const row of turnRows.values()) {
  const queryId = row.query_id as string
  const existing = queryLoopStats.get(queryId) ?? {
    maxLoopIter: null,
    totalLoopIter: 0,
    loopIterCount: 0,
  }
  const loopIterEnd =
    row.loop_iter_end === null || row.loop_iter_end === undefined
      ? null
      : Number(row.loop_iter_end)
  if (loopIterEnd !== null && Number.isFinite(loopIterEnd)) {
    existing.maxLoopIter =
      existing.maxLoopIter === null
        ? loopIterEnd
        : Math.max(existing.maxLoopIter, loopIterEnd)
    existing.totalLoopIter += loopIterEnd
    existing.loopIterCount += 1
  }
  queryLoopStats.set(queryId, existing)
}

const queryInsertRows = [...queryRows.values()].map(row => {
  const strictIsComplete =
    Number(row.raw_query_started_count) > 0 && Number(row.raw_query_terminated_count) > 0
  const inferredIsComplete =
    Number(row.inferred_query_started_count) > 0 &&
    Number(row.inferred_query_terminated_count) > 0
  const loopStats = queryLoopStats.get(String(row.query_id))
  return {
    query_id: row.query_id,
    user_action_id: row.user_action_id,
    session_id: row.session_id,
    conversation_id: row.conversation_id,
    query_source: row.query_source,
    subagent_id: row.subagent_id,
    subagent_type: row.subagent_type,
    subagent_reason: row.subagent_reason,
    subagent_trigger_kind: row.subagent_trigger_kind,
    subagent_trigger_detail: row.subagent_trigger_detail,
    subagent_trigger_payload_json: row.subagent_trigger_payload_json,
    agent_name: row.agent_name,
    source_group: row.source_group,
    started_at: row.started_at,
    started_at_ms: row.started_at_ms,
    ended_at: row.ended_at,
    ended_at_ms: row.ended_at_ms,
    duration_ms: Number(row.ended_at_ms) - Number(row.started_at_ms),
    first_event: row.first_event,
    last_event: row.last_event,
    terminal_reason: row.terminal_reason,
    stop_reason: row.stop_reason,
    turn_count: (row.turn_ids as Set<string>).size,
    query_max_loop_iter: loopStats?.maxLoopIter ?? null,
    query_avg_loop_iter:
      loopStats && loopStats.loopIterCount > 0
        ? Math.round((loopStats.totalLoopIter / loopStats.loopIterCount) * 1000) / 1000
        : null,
    tool_call_count: (row.tool_call_ids as Set<string>).size,
    event_count: row.event_count,
    raw_query_started_count: row.raw_query_started_count,
    raw_query_terminated_count: row.raw_query_terminated_count,
    inferred_query_started_count: row.inferred_query_started_count,
    inferred_query_terminated_count: row.inferred_query_terminated_count,
    strict_is_complete: strictIsComplete,
    inferred_is_complete: inferredIsComplete,
  }
})

const turnInsertRows = [...turnRows.values()].map(row => {
  const strictTerminalTurnClosed =
    Number(row.raw_turn_started_count) > 0 &&
    Number(row.raw_state_before_count) > 0 &&
    Number(row.raw_state_after_count) === 0 &&
    row.stop_reason === "end_turn" &&
    row.termination_reason !== null
  const inferredTerminalTurnClosed =
    Number(row.inferred_turn_started_count) > 0 &&
    Number(row.inferred_state_before_count) > 0 &&
    Number(row.inferred_state_after_count) === 0 &&
    row.stop_reason === "end_turn" &&
    row.termination_reason !== null
  const strictIsClosed =
    (
      Number(row.raw_turn_started_count) > 0 &&
      Number(row.raw_state_before_count) > 0 &&
      Number(row.raw_state_after_count) > 0
    ) || strictTerminalTurnClosed
  const inferredIsClosed =
    (
      Number(row.inferred_turn_started_count) > 0 &&
      Number(row.inferred_state_before_count) > 0 &&
      Number(row.inferred_state_after_count) > 0
    ) || inferredTerminalTurnClosed
  return {
    turn_key: row.turn_key,
    query_id: row.query_id,
    turn_id: row.turn_id,
    user_action_id: row.user_action_id,
    subagent_id: row.subagent_id,
    query_source: row.query_source,
    subagent_reason: row.subagent_reason,
    agent_name: row.agent_name,
    source_group: row.source_group,
    loop_iter_start: row.loop_iter_start,
    loop_iter_end: row.loop_iter_end,
    started_at: row.started_at,
    started_at_ms: row.started_at_ms,
    ended_at: row.ended_at,
    ended_at_ms: row.ended_at_ms,
    duration_ms: Number(row.ended_at_ms) - Number(row.started_at_ms),
    first_event: row.first_event,
    last_event: row.last_event,
    transition_out: row.transition_out,
    termination_reason: row.termination_reason,
    stop_reason: row.stop_reason,
    tool_call_count: (row.tool_call_ids as Set<string>).size,
    assistant_tool_use_count: row.assistant_tool_use_count,
    event_count: row.event_count,
    raw_turn_started_count: row.raw_turn_started_count,
    raw_state_before_count: row.raw_state_before_count,
    raw_state_after_count: row.raw_state_after_count,
    inferred_turn_started_count: row.inferred_turn_started_count,
    inferred_state_before_count: row.inferred_state_before_count,
    inferred_state_after_count: row.inferred_state_after_count,
    strict_is_closed: strictIsClosed,
    inferred_is_closed: inferredIsClosed,
  }
})

const toolInsertRows = [...toolRows.values()].map(row => ({
  tool_call_id: row.tool_call_id,
  user_action_id: row.user_action_id,
  query_id: row.query_id,
  turn_id: row.turn_id,
  subagent_id: row.subagent_id,
  tool_name: row.tool_name,
  execution_mode: row.execution_mode,
  detected_at: row.detected_at,
  detected_at_ms: row.detected_at_ms,
  enqueued_at: row.enqueued_at,
  enqueued_at_ms: row.enqueued_at_ms,
  started_at: row.started_at,
  started_at_ms: row.started_at_ms,
  completed_at: row.completed_at,
  completed_at_ms: row.completed_at_ms,
  duration_ms: row.duration_ms,
  success: row.success,
  failure_reason: row.failure_reason,
  event_count: row.event_count,
  has_tool_use_detected: row.has_tool_use_detected,
  has_started: row.has_started,
  has_completed: row.has_completed,
  has_failed: row.has_failed,
  is_closed: Boolean(row.has_tool_use_detected) && (Boolean(row.has_completed) || Boolean(row.has_failed)),
}))

const subagentInsertRows = [...subagentRows.values()].map(row => ({
  subagent_id: row.subagent_id,
  query_id: row.query_id,
  user_action_id: row.user_action_id,
  subagent_type: row.subagent_type,
  subagent_reason: row.subagent_reason,
  subagent_trigger_kind: row.subagent_trigger_kind,
  subagent_trigger_detail: row.subagent_trigger_detail,
  subagent_trigger_payload_json: row.subagent_trigger_payload_json,
  query_source: row.query_source,
  agent_name: row.agent_name,
  source_group: row.source_group,
  spawned_at: row.spawned_at,
  spawned_at_ms: row.spawned_at_ms,
  completed_at: row.completed_at,
  completed_at_ms: row.completed_at_ms,
  duration_ms: row.duration_ms,
  transcript_enabled: row.transcript_enabled,
  inherited_message_count: row.inherited_message_count,
  prompt_message_count: row.prompt_message_count,
  message_event_count: row.message_event_count,
  has_spawned: row.has_spawned,
  has_completed: row.has_completed,
}))

const snapshotInsertRows = [...referencedSnapshots.values()]
const usageFactRows = usageFacts

const dailyRollupRows = [...dailyRollups.values()].map(row => ({
  event_date: row.event_date,
  event_count: row.event_count,
  user_action_count: (row.user_action_ids as Set<string>).size,
  query_count: (row.query_ids as Set<string>).size,
  turn_count: (row.turn_keys as Set<string>).size,
  tool_call_count: (row.tool_call_ids as Set<string>).size,
  subagent_count: (row.subagent_ids as Set<string>).size,
  snapshot_ref_count: (row.snapshot_refs as Set<string>).size,
  latest_event_ts: row.latest_event_ts,
}))

const buildMetaRows = [
  {
    source_events_file: eventsPath,
    source_events_file_name: basename(eventsPath),
    source_events_size_bytes: eventsFileStat.size,
    source_events_mtime_ms: Math.trunc(eventsFileStat.mtimeMs),
    built_at: new Date().toISOString(),
    built_at_ms: Date.now(),
    events_row_count: eventsRawRows.length,
  },
]

const sql = `
BEGIN TRANSACTION;
DROP TABLE IF EXISTS build_meta;
DROP TABLE IF EXISTS events_raw;
DROP TABLE IF EXISTS queries;
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS tools;
DROP TABLE IF EXISTS subagents;
DROP TABLE IF EXISTS recoveries;
DROP TABLE IF EXISTS snapshots_index;
DROP TABLE IF EXISTS usage_facts;
DROP TABLE IF EXISTS daily_rollups;

CREATE TABLE build_meta (
  source_events_file VARCHAR,
  source_events_file_name VARCHAR,
  source_events_size_bytes BIGINT,
  source_events_mtime_ms BIGINT,
  built_at VARCHAR,
  built_at_ms BIGINT,
  events_row_count BIGINT
);

CREATE TABLE events_raw (
  event_idx BIGINT,
  schema_version VARCHAR,
  event_date VARCHAR,
  ts_wall VARCHAR,
  ts_wall_ms BIGINT,
  ts_mono_ms BIGINT,
  level VARCHAR,
  event_name VARCHAR,
  component VARCHAR,
  session_id VARCHAR,
  conversation_id VARCHAR,
  user_action_id VARCHAR,
  query_id VARCHAR,
  effective_query_id VARCHAR,
  turn_id VARCHAR,
  loop_iter BIGINT,
  parent_turn_id VARCHAR,
  subagent_id VARCHAR,
  subagent_type VARCHAR,
  subagent_reason VARCHAR,
  subagent_trigger_kind VARCHAR,
  subagent_trigger_detail VARCHAR,
  subagent_trigger_payload_json VARCHAR,
  agent_name VARCHAR,
  source_group VARCHAR,
  query_source VARCHAR,
  request_id VARCHAR,
  tool_call_id VARCHAR,
  span_id VARCHAR,
  parent_span_id VARCHAR,
  cwd VARCHAR,
  git_branch VARCHAR,
  build_version VARCHAR,
  payload_json VARCHAR,
  snapshot_refs_json VARCHAR,
  raw_event_json VARCHAR
);

CREATE TABLE queries (
  query_id VARCHAR,
  user_action_id VARCHAR,
  session_id VARCHAR,
  conversation_id VARCHAR,
  query_source VARCHAR,
  subagent_id VARCHAR,
  subagent_type VARCHAR,
  subagent_reason VARCHAR,
  subagent_trigger_kind VARCHAR,
  subagent_trigger_detail VARCHAR,
  subagent_trigger_payload_json VARCHAR,
  agent_name VARCHAR,
  source_group VARCHAR,
  started_at VARCHAR,
  started_at_ms BIGINT,
  ended_at VARCHAR,
  ended_at_ms BIGINT,
  duration_ms BIGINT,
  first_event VARCHAR,
  last_event VARCHAR,
  terminal_reason VARCHAR,
  stop_reason VARCHAR,
  turn_count BIGINT,
  query_max_loop_iter DOUBLE,
  query_avg_loop_iter DOUBLE,
  tool_call_count BIGINT,
  event_count BIGINT,
  raw_query_started_count BIGINT,
  raw_query_terminated_count BIGINT,
  inferred_query_started_count BIGINT,
  inferred_query_terminated_count BIGINT,
  strict_is_complete BOOLEAN,
  inferred_is_complete BOOLEAN
);

CREATE TABLE turns (
  turn_key VARCHAR,
  query_id VARCHAR,
  turn_id VARCHAR,
  user_action_id VARCHAR,
  subagent_id VARCHAR,
  query_source VARCHAR,
  subagent_reason VARCHAR,
  agent_name VARCHAR,
  source_group VARCHAR,
  loop_iter_start BIGINT,
  loop_iter_end BIGINT,
  started_at VARCHAR,
  started_at_ms BIGINT,
  ended_at VARCHAR,
  ended_at_ms BIGINT,
  duration_ms BIGINT,
  first_event VARCHAR,
  last_event VARCHAR,
  transition_out VARCHAR,
  termination_reason VARCHAR,
  stop_reason VARCHAR,
  tool_call_count BIGINT,
  assistant_tool_use_count BIGINT,
  event_count BIGINT,
  raw_turn_started_count BIGINT,
  raw_state_before_count BIGINT,
  raw_state_after_count BIGINT,
  inferred_turn_started_count BIGINT,
  inferred_state_before_count BIGINT,
  inferred_state_after_count BIGINT,
  strict_is_closed BOOLEAN,
  inferred_is_closed BOOLEAN
);

CREATE TABLE tools (
  tool_call_id VARCHAR,
  user_action_id VARCHAR,
  query_id VARCHAR,
  turn_id VARCHAR,
  subagent_id VARCHAR,
  tool_name VARCHAR,
  execution_mode VARCHAR,
  detected_at VARCHAR,
  detected_at_ms BIGINT,
  enqueued_at VARCHAR,
  enqueued_at_ms BIGINT,
  started_at VARCHAR,
  started_at_ms BIGINT,
  completed_at VARCHAR,
  completed_at_ms BIGINT,
  duration_ms BIGINT,
  success BOOLEAN,
  failure_reason VARCHAR,
  event_count BIGINT,
  has_tool_use_detected BOOLEAN,
  has_started BOOLEAN,
  has_completed BOOLEAN,
  has_failed BOOLEAN,
  is_closed BOOLEAN
);

CREATE TABLE subagents (
  subagent_id VARCHAR,
  query_id VARCHAR,
  user_action_id VARCHAR,
  subagent_type VARCHAR,
  subagent_reason VARCHAR,
  subagent_trigger_kind VARCHAR,
  subagent_trigger_detail VARCHAR,
  subagent_trigger_payload_json VARCHAR,
  query_source VARCHAR,
  agent_name VARCHAR,
  source_group VARCHAR,
  spawned_at VARCHAR,
  spawned_at_ms BIGINT,
  completed_at VARCHAR,
  completed_at_ms BIGINT,
  duration_ms BIGINT,
  transcript_enabled BOOLEAN,
  inherited_message_count BIGINT,
  prompt_message_count BIGINT,
  message_event_count BIGINT,
  has_spawned BOOLEAN,
  has_completed BOOLEAN
);

CREATE TABLE recoveries (
  recovery_key VARCHAR,
  event_name VARCHAR,
  user_action_id VARCHAR,
  query_id VARCHAR,
  turn_id VARCHAR,
  subagent_id VARCHAR,
  ts_wall VARCHAR,
  ts_wall_ms BIGINT,
  transition_to VARCHAR,
  reason VARCHAR,
  payload_json VARCHAR
);

CREATE TABLE snapshots_index (
  snapshot_ref VARCHAR,
  file_name VARCHAR,
  relative_path VARCHAR,
  absolute_path VARCHAR,
  exists BOOLEAN,
  size_bytes BIGINT,
  sha256 VARCHAR,
  referenced_count BIGINT,
  first_event_ts VARCHAR,
  last_event_ts VARCHAR,
  category VARCHAR
);

CREATE TABLE usage_facts (
  usage_fact_id VARCHAR,
  event_date VARCHAR,
  ts_wall VARCHAR,
  ts_wall_ms BIGINT,
  user_action_id VARCHAR,
  query_id VARCHAR,
  query_source VARCHAR,
  subagent_id VARCHAR,
  subagent_reason VARCHAR,
  agent_name VARCHAR,
  source_group VARCHAR,
  source_kind VARCHAR,
  source_ref VARCHAR,
  request_id VARCHAR,
  assistant_message_count BIGINT,
  is_authoritative BOOLEAN,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_input_tokens BIGINT,
  cache_creation_input_tokens BIGINT,
  total_prompt_input_tokens BIGINT,
  total_billed_tokens BIGINT
);

CREATE TABLE daily_rollups (
  event_date VARCHAR,
  event_count BIGINT,
  user_action_count BIGINT,
  query_count BIGINT,
  turn_count BIGINT,
  tool_call_count BIGINT,
  subagent_count BIGINT,
  snapshot_ref_count BIGINT,
  latest_event_ts VARCHAR
);

${createInsertSql("build_meta", [
  "source_events_file",
  "source_events_file_name",
  "source_events_size_bytes",
  "source_events_mtime_ms",
  "built_at",
  "built_at_ms",
  "events_row_count",
], buildMetaRows)}

${createInsertSql("events_raw", [
  "event_idx",
  "schema_version",
  "event_date",
  "ts_wall",
  "ts_wall_ms",
  "ts_mono_ms",
  "level",
  "event_name",
  "component",
  "session_id",
  "conversation_id",
  "user_action_id",
  "query_id",
  "effective_query_id",
  "turn_id",
  "loop_iter",
  "parent_turn_id",
  "subagent_id",
  "subagent_type",
  "subagent_reason",
  "subagent_trigger_kind",
  "subagent_trigger_detail",
  "subagent_trigger_payload_json",
  "agent_name",
  "source_group",
  "query_source",
  "request_id",
  "tool_call_id",
  "span_id",
  "parent_span_id",
  "cwd",
  "git_branch",
  "build_version",
  "payload_json",
  "snapshot_refs_json",
  "raw_event_json",
], eventsRawRows)}

${createInsertSql("queries", [
  "query_id",
  "user_action_id",
  "session_id",
  "conversation_id",
  "query_source",
  "subagent_id",
  "subagent_type",
  "subagent_reason",
  "subagent_trigger_kind",
  "subagent_trigger_detail",
  "subagent_trigger_payload_json",
  "agent_name",
  "source_group",
  "started_at",
  "started_at_ms",
  "ended_at",
  "ended_at_ms",
  "duration_ms",
  "first_event",
  "last_event",
  "terminal_reason",
  "stop_reason",
  "turn_count",
  "query_max_loop_iter",
  "query_avg_loop_iter",
  "tool_call_count",
  "event_count",
  "raw_query_started_count",
  "raw_query_terminated_count",
  "inferred_query_started_count",
  "inferred_query_terminated_count",
  "strict_is_complete",
  "inferred_is_complete",
], queryInsertRows)}

${createInsertSql("turns", [
  "turn_key",
  "query_id",
  "turn_id",
  "user_action_id",
  "subagent_id",
  "query_source",
  "subagent_reason",
  "agent_name",
  "source_group",
  "loop_iter_start",
  "loop_iter_end",
  "started_at",
  "started_at_ms",
  "ended_at",
  "ended_at_ms",
  "duration_ms",
  "first_event",
  "last_event",
  "transition_out",
  "termination_reason",
  "stop_reason",
  "tool_call_count",
  "assistant_tool_use_count",
  "event_count",
  "raw_turn_started_count",
  "raw_state_before_count",
  "raw_state_after_count",
  "inferred_turn_started_count",
  "inferred_state_before_count",
  "inferred_state_after_count",
  "strict_is_closed",
  "inferred_is_closed",
], turnInsertRows)}

${createInsertSql("tools", [
  "tool_call_id",
  "user_action_id",
  "query_id",
  "turn_id",
  "subagent_id",
  "tool_name",
  "execution_mode",
  "detected_at",
  "detected_at_ms",
  "enqueued_at",
  "enqueued_at_ms",
  "started_at",
  "started_at_ms",
  "completed_at",
  "completed_at_ms",
  "duration_ms",
  "success",
  "failure_reason",
  "event_count",
  "has_tool_use_detected",
  "has_started",
  "has_completed",
  "has_failed",
  "is_closed",
], toolInsertRows)}

${createInsertSql("subagents", [
  "subagent_id",
  "query_id",
  "user_action_id",
  "subagent_type",
  "subagent_reason",
  "subagent_trigger_kind",
  "subagent_trigger_detail",
  "subagent_trigger_payload_json",
  "query_source",
  "agent_name",
  "source_group",
  "spawned_at",
  "spawned_at_ms",
  "completed_at",
  "completed_at_ms",
  "duration_ms",
  "transcript_enabled",
  "inherited_message_count",
  "prompt_message_count",
  "message_event_count",
  "has_spawned",
  "has_completed",
], subagentInsertRows)}

${createInsertSql("recoveries", [
  "recovery_key",
  "event_name",
  "user_action_id",
  "query_id",
  "turn_id",
  "subagent_id",
  "ts_wall",
  "ts_wall_ms",
  "transition_to",
  "reason",
  "payload_json",
], recoveryRows)}

${createInsertSql("snapshots_index", [
  "snapshot_ref",
  "file_name",
  "relative_path",
  "absolute_path",
  "exists",
  "size_bytes",
  "sha256",
  "referenced_count",
  "first_event_ts",
  "last_event_ts",
  "category",
], snapshotInsertRows)}

${createInsertSql("usage_facts", [
  "usage_fact_id",
  "event_date",
  "ts_wall",
  "ts_wall_ms",
  "user_action_id",
  "query_id",
  "query_source",
  "subagent_id",
  "subagent_reason",
  "agent_name",
  "source_group",
  "source_kind",
  "source_ref",
  "request_id",
  "assistant_message_count",
  "is_authoritative",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_prompt_input_tokens",
  "total_billed_tokens",
], usageFactRows)}

${createInsertSql("daily_rollups", [
  "event_date",
  "event_count",
  "user_action_count",
  "query_count",
  "turn_count",
  "tool_call_count",
  "subagent_count",
  "snapshot_ref_count",
  "latest_event_ts",
], dailyRollupRows)}

CREATE OR REPLACE VIEW user_actions AS
WITH usage_authoritative AS (
  SELECT
    event_date,
    user_action_id,
    SUM(input_tokens) AS raw_input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_input_tokens) AS cache_read_tokens,
    SUM(cache_creation_input_tokens) AS cache_create_tokens,
    SUM(total_prompt_input_tokens) AS total_prompt_input_tokens,
    SUM(total_billed_tokens) AS total_billed_tokens,
    SUM(CASE WHEN agent_name = 'main_thread' THEN total_prompt_input_tokens ELSE 0 END) AS main_thread_total_prompt_input_tokens,
    SUM(CASE WHEN agent_name <> 'main_thread' THEN total_prompt_input_tokens ELSE 0 END) AS subagent_total_prompt_input_tokens
  FROM usage_facts
  WHERE is_authoritative AND user_action_id IS NOT NULL
  GROUP BY 1, 2
),
event_agg AS (
  SELECT
    event_date,
    user_action_id,
    MIN(ts_wall) AS started_at,
    MIN(ts_wall_ms) AS started_at_ms,
    MAX(ts_wall) AS ended_at,
    MAX(ts_wall_ms) AS ended_at_ms,
    MAX(ts_wall_ms) - MIN(ts_wall_ms) AS duration_ms,
    COUNT(*) AS event_count,
    COUNT(DISTINCT effective_query_id) FILTER (WHERE effective_query_id IS NOT NULL) AS query_count,
    COUNT(DISTINCT effective_query_id) FILTER (WHERE effective_query_id IS NOT NULL AND agent_name = 'main_thread') AS main_thread_query_count,
    COUNT(DISTINCT effective_query_id) FILTER (WHERE effective_query_id IS NOT NULL AND agent_name <> 'main_thread') AS subagent_query_count,
    COUNT(DISTINCT subagent_id) FILTER (WHERE subagent_id IS NOT NULL) AS subagent_count,
    COUNT(DISTINCT tool_call_id) FILTER (WHERE tool_call_id IS NOT NULL) AS tool_call_count
  FROM events_raw
  WHERE user_action_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  e.event_date,
  e.user_action_id,
  e.started_at,
  e.started_at_ms,
  e.ended_at,
  e.ended_at_ms,
  e.duration_ms,
  e.event_count,
  e.query_count,
  e.main_thread_query_count,
  e.subagent_query_count,
  e.subagent_count,
  e.tool_call_count,
  COALESCE(u.raw_input_tokens, 0) AS raw_input_tokens,
  COALESCE(u.output_tokens, 0) AS output_tokens,
  COALESCE(u.cache_read_tokens, 0) AS cache_read_tokens,
  COALESCE(u.cache_create_tokens, 0) AS cache_create_tokens,
  COALESCE(u.total_prompt_input_tokens, 0) AS total_prompt_input_tokens,
  COALESCE(u.total_billed_tokens, 0) AS total_billed_tokens,
  COALESCE(u.main_thread_total_prompt_input_tokens, 0) AS main_thread_total_prompt_input_tokens,
  COALESCE(u.subagent_total_prompt_input_tokens, 0) AS subagent_total_prompt_input_tokens
FROM event_agg e
LEFT JOIN usage_authoritative u
  ON u.event_date = e.event_date
 AND u.user_action_id = e.user_action_id;

CREATE OR REPLACE VIEW query_source_cost_share AS
WITH per_source AS (
  SELECT
    event_date,
    user_action_id,
    query_source,
    SUM(input_tokens) AS raw_input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_input_tokens) AS cache_read_tokens,
    SUM(cache_creation_input_tokens) AS cache_create_tokens,
    SUM(total_prompt_input_tokens) AS total_prompt_input_tokens,
    SUM(total_billed_tokens) AS total_billed_tokens
  FROM usage_facts
  WHERE is_authoritative AND user_action_id IS NOT NULL
  GROUP BY 1, 2, 3
),
per_action AS (
  SELECT
    event_date,
    user_action_id,
    SUM(total_billed_tokens) AS action_total_billed_tokens
  FROM per_source
  GROUP BY 1, 2
)
SELECT
  s.event_date,
  s.user_action_id,
  s.query_source,
  s.raw_input_tokens,
  s.output_tokens,
  s.cache_read_tokens,
  s.cache_create_tokens,
  s.total_prompt_input_tokens,
  s.total_billed_tokens,
  CASE
    WHEN a.action_total_billed_tokens = 0 THEN NULL
    ELSE ROUND(s.total_billed_tokens * 1.0 / a.action_total_billed_tokens, 6)
  END AS cost_share
FROM per_source s
LEFT JOIN per_action a
  ON a.event_date = s.event_date
 AND a.user_action_id = s.user_action_id;

CREATE OR REPLACE VIEW query_source_cost_share_daily AS
WITH per_day AS (
  SELECT
    event_date,
    query_source,
    SUM(raw_input_tokens) AS raw_input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_create_tokens) AS cache_create_tokens,
    SUM(total_prompt_input_tokens) AS total_prompt_input_tokens,
    SUM(total_billed_tokens) AS total_billed_tokens
  FROM query_source_cost_share
  GROUP BY 1, 2
),
day_total AS (
  SELECT
    event_date,
    SUM(total_billed_tokens) AS day_total_billed_tokens
  FROM per_day
  GROUP BY 1
)
SELECT
  p.event_date,
  p.query_source,
  p.raw_input_tokens,
  p.output_tokens,
  p.cache_read_tokens,
  p.cache_create_tokens,
  p.total_prompt_input_tokens,
  p.total_billed_tokens,
  CASE
    WHEN d.day_total_billed_tokens = 0 THEN NULL
    ELSE ROUND(p.total_billed_tokens * 1.0 / d.day_total_billed_tokens, 6)
  END AS daily_cost_share
FROM per_day p
LEFT JOIN day_total d
  ON d.event_date = p.event_date;

CREATE OR REPLACE VIEW agent_cost_daily AS
WITH per_agent AS (
  SELECT
    event_date,
    COALESCE(agent_name, 'unknown') AS agent_name,
    COALESCE(source_group, 'unknown') AS source_group,
    SUM(input_tokens) AS agent_total_raw_input_tokens,
    SUM(output_tokens) AS agent_total_output_tokens,
    SUM(cache_read_input_tokens) AS agent_total_cache_read_tokens,
    SUM(cache_creation_input_tokens) AS agent_total_cache_create_tokens,
    SUM(total_prompt_input_tokens) AS agent_total_prompt_input_tokens,
    SUM(total_billed_tokens) AS agent_total_billed_tokens
  FROM usage_facts
  WHERE is_authoritative
  GROUP BY 1, 2, 3
),
per_day AS (
  SELECT
    event_date,
    SUM(agent_total_billed_tokens) AS day_total_billed_tokens
  FROM per_agent
  GROUP BY 1
),
query_stats AS (
  SELECT
    SUBSTR(started_at, 1, 10) AS event_date,
    COALESCE(agent_name, 'unknown') AS agent_name,
    COUNT(*) AS agent_query_count,
    SUM(turn_count) AS agent_turn_count,
    ROUND(AVG(turn_count), 3) AS agent_avg_turns_per_query,
    ROUND(AVG(query_max_loop_iter), 3) AS agent_avg_loop_iter_end,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY query_max_loop_iter), 3) AS agent_p95_loop_iter_end,
    ROUND(AVG(CASE WHEN COALESCE(query_max_loop_iter, 0) > 1 THEN 1.0 ELSE 0.0 END), 6) AS agent_queries_with_loop_iter_gt_1_rate
  FROM queries
  GROUP BY 1, 2
)
SELECT
  p.event_date,
  p.agent_name,
  p.source_group,
  p.agent_total_raw_input_tokens,
  p.agent_total_output_tokens,
  p.agent_total_cache_read_tokens,
  p.agent_total_cache_create_tokens,
  p.agent_total_prompt_input_tokens,
  p.agent_total_billed_tokens,
  CASE
    WHEN d.day_total_billed_tokens = 0 THEN NULL
    ELSE ROUND(p.agent_total_billed_tokens * 1.0 / d.day_total_billed_tokens, 6)
  END AS agent_cost_share,
  COALESCE(qs.agent_query_count, 0) AS agent_query_count,
  COALESCE(qs.agent_turn_count, 0) AS agent_turn_count,
  qs.agent_avg_turns_per_query,
  qs.agent_avg_loop_iter_end,
  qs.agent_p95_loop_iter_end,
  qs.agent_queries_with_loop_iter_gt_1_rate
FROM per_agent p
LEFT JOIN per_day d ON d.event_date = p.event_date
LEFT JOIN query_stats qs
  ON qs.event_date = p.event_date
 AND qs.agent_name = p.agent_name;

CREATE OR REPLACE VIEW subagent_reason_daily AS
SELECT
  SUBSTR(COALESCE(spawned_at, completed_at), 1, 10) AS event_date,
  COALESCE(subagent_reason, 'unknown') AS subagent_reason,
  COALESCE(agent_name, 'unknown') AS agent_name,
  COUNT(*) AS subagent_count,
  ROUND(AVG(duration_ms), 3) AS avg_duration_ms,
  ROUND(AVG(prompt_message_count), 3) AS avg_prompt_message_count,
  ROUND(AVG(message_event_count), 3) AS avg_message_event_count
FROM subagents
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW metrics_integrity_daily AS
WITH user_action_coverage AS (
  SELECT
    event_date,
    ROUND(AVG(CASE WHEN main_thread_query_count > 0 THEN 1.0 ELSE 0.0 END), 6) AS user_action_main_query_coverage_rate
  FROM user_actions
  GROUP BY 1
)
SELECT
  r.event_date,
  COALESCE(u.user_action_main_query_coverage_rate, 0) AS user_action_main_query_coverage_rate,
  ROUND((SELECT AVG(CASE WHEN strict_is_complete THEN 1.0 ELSE 0.0 END) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date), 6) AS strict_query_completion_rate,
  ROUND((SELECT AVG(CASE WHEN inferred_is_complete THEN 1.0 ELSE 0.0 END) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date), 6) AS inferred_query_completion_rate,
  ROUND(
    COALESCE((SELECT AVG(CASE WHEN inferred_is_complete THEN 1.0 ELSE 0.0 END) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date), 0)
    -
    COALESCE((SELECT AVG(CASE WHEN strict_is_complete THEN 1.0 ELSE 0.0 END) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date), 0),
    6
  ) AS query_completeness_gap,
  ROUND((SELECT AVG(CASE WHEN strict_is_closed THEN 1.0 ELSE 0.0 END) FROM turns t WHERE SUBSTR(t.started_at, 1, 10) = r.event_date), 6) AS strict_turn_state_closure_rate,
  ROUND((SELECT AVG(CASE WHEN inferred_is_closed THEN 1.0 ELSE 0.0 END) FROM turns t WHERE SUBSTR(t.started_at, 1, 10) = r.event_date), 6) AS inferred_turn_state_closure_rate,
  ROUND(
    COALESCE((SELECT AVG(CASE WHEN inferred_is_closed THEN 1.0 ELSE 0.0 END) FROM turns t WHERE SUBSTR(t.started_at, 1, 10) = r.event_date), 0)
    -
    COALESCE((SELECT AVG(CASE WHEN strict_is_closed THEN 1.0 ELSE 0.0 END) FROM turns t WHERE SUBSTR(t.started_at, 1, 10) = r.event_date), 0),
    6
  ) AS turn_closure_gap,
  ROUND((SELECT AVG(CASE WHEN is_closed THEN 1.0 ELSE 0.0 END) FROM tools t WHERE COALESCE(t.detected_at, t.started_at, t.completed_at, '') LIKE r.event_date || '%'), 6) AS tool_lifecycle_closure_rate,
  ROUND((SELECT AVG(CASE WHEN has_spawned AND has_completed THEN 1.0 ELSE 0.0 END) FROM subagents s WHERE COALESCE(s.spawned_at, s.completed_at, '') LIKE r.event_date || '%'), 6) AS subagent_lifecycle_closure_rate,
  CASE
    WHEN (SELECT COUNT(*) FROM snapshots_index si WHERE COALESCE(si.first_event_ts, '') LIKE r.event_date || '%' AND si.referenced_count > 0) = 0 THEN 0
    ELSE ROUND(
      (SELECT COUNT(*) FROM snapshots_index si WHERE COALESCE(si.first_event_ts, '') LIKE r.event_date || '%' AND si.referenced_count > 0 AND NOT si.exists) * 1.0
      /
      (SELECT COUNT(*) FROM snapshots_index si WHERE COALESCE(si.first_event_ts, '') LIKE r.event_date || '%' AND si.referenced_count > 0),
      6
    )
  END AS snapshot_missing_rate,
  ROUND(AVG(CASE WHEN er.user_action_id IS NULL AND er.effective_query_id IS NULL AND er.turn_id IS NULL AND er.tool_call_id IS NULL AND er.subagent_id IS NULL THEN 1.0 ELSE 0.0 END), 6) AS orphan_event_rate
FROM daily_rollups r
LEFT JOIN events_raw er ON er.event_date = r.event_date
LEFT JOIN user_action_coverage u ON u.event_date = r.event_date
GROUP BY 1, u.user_action_main_query_coverage_rate;

CREATE OR REPLACE VIEW metrics_cost_daily AS
WITH completed_queries AS (
  SELECT
    SUBSTR(started_at, 1, 10) AS event_date,
    COUNT(*) FILTER (WHERE inferred_is_complete AND terminal_reason = 'completed') AS successful_completed_query_count
  FROM queries
  GROUP BY 1
),
query_costs AS (
  SELECT
    event_date,
    query_id,
    SUM(total_prompt_input_tokens) AS query_total_prompt_input_tokens,
    SUM(total_billed_tokens) AS query_total_billed_tokens
  FROM usage_facts
  WHERE is_authoritative AND query_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  ua.event_date,
  SUM(ua.raw_input_tokens) AS user_action_total_raw_input_tokens,
  SUM(ua.output_tokens) AS user_action_total_output_tokens,
  SUM(ua.cache_read_tokens) AS user_action_total_cache_read_tokens,
  SUM(ua.cache_create_tokens) AS user_action_total_cache_create_tokens,
  SUM(ua.total_prompt_input_tokens) AS user_action_total_prompt_input_tokens,
  SUM(ua.total_billed_tokens) AS user_action_total_billed_tokens,
  SUM(ua.main_thread_total_prompt_input_tokens) AS main_thread_total_prompt_input_tokens,
  SUM(ua.subagent_total_prompt_input_tokens) AS subagent_total_prompt_input_tokens,
  ROUND(AVG(ua.total_prompt_input_tokens), 3) AS avg_total_prompt_input_tokens_per_user_action,
  ROUND(AVG(ua.total_billed_tokens), 3) AS avg_total_billed_tokens_per_user_action,
  ROUND((SELECT AVG(query_total_prompt_input_tokens) FROM query_costs qc WHERE qc.event_date = ua.event_date), 3) AS avg_total_prompt_input_tokens_per_query,
  ROUND((SELECT AVG(query_total_billed_tokens) FROM query_costs qc WHERE qc.event_date = ua.event_date), 3) AS avg_total_billed_tokens_per_query,
  CASE
    WHEN SUM(ua.main_thread_total_prompt_input_tokens) = 0 THEN NULL
    ELSE ROUND(SUM(ua.subagent_total_prompt_input_tokens) * 1.0 / SUM(ua.main_thread_total_prompt_input_tokens), 6)
  END AS subagent_amplification_ratio,
  CASE
    WHEN COALESCE(MAX(c.successful_completed_query_count), 0) = 0 THEN NULL
    ELSE ROUND(SUM(ua.total_billed_tokens) * 1.0 / MAX(c.successful_completed_query_count), 6)
  END AS cost_per_successful_completed_query
FROM user_actions ua
LEFT JOIN completed_queries c ON c.event_date = ua.event_date
GROUP BY 1;

CREATE OR REPLACE VIEW metrics_loop_daily AS
SELECT
  SUBSTR(started_at, 1, 10) AS event_date,
  ROUND(AVG(turn_count), 3) AS daily_avg_turns_per_query,
  ROUND(AVG(query_max_loop_iter), 3) AS daily_avg_loop_iter_end,
  ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY query_max_loop_iter), 3) AS daily_p95_loop_iter_end,
  ROUND(AVG(CASE WHEN COALESCE(query_max_loop_iter, 0) > 1 THEN 1.0 ELSE 0.0 END), 6) AS daily_queries_with_loop_iter_gt_1_rate
FROM queries
GROUP BY 1;

CREATE OR REPLACE VIEW metrics_latency_daily AS
WITH turn_latencies AS (
  SELECT
    event_date,
    query_id,
    turn_id,
    MAX(CASE WHEN event_name = 'turn.started' THEN ts_wall_ms END) AS turn_started_ms,
    MAX(CASE WHEN event_name = 'state.snapshot.before_turn' THEN ts_wall_ms END) AS before_turn_ms,
    MAX(CASE WHEN event_name = 'prompt.build.started' THEN ts_wall_ms END) AS prompt_build_started_ms,
    MAX(CASE WHEN event_name = 'prompt.build.completed' THEN ts_wall_ms END) AS prompt_build_completed_ms,
    MAX(CASE WHEN event_name = 'api.request.started' THEN ts_wall_ms END) AS api_request_started_ms,
    MIN(CASE WHEN event_name = 'api.stream.first_chunk' THEN ts_wall_ms END) AS api_first_chunk_ms,
    MAX(CASE WHEN event_name = 'api.stream.completed' THEN ts_wall_ms END) AS api_completed_ms
  FROM events_raw
  WHERE effective_query_id IS NOT NULL AND turn_id IS NOT NULL
  GROUP BY 1, 2, 3
),
action_first_chunk AS (
  SELECT
    event_date,
    user_action_id,
    MIN(ts_wall_ms) AS action_started_ms,
    MIN(CASE WHEN event_name = 'api.stream.first_chunk' AND agent_name = 'main_thread' THEN ts_wall_ms END) AS main_first_chunk_ms
  FROM events_raw
  WHERE user_action_id IS NOT NULL
  GROUP BY 1, 2
),
stop_hook_durations AS (
  SELECT
    event_date,
    AVG(COALESCE(TRY_CAST(json_extract(payload_json, '$.duration_ms') AS DOUBLE), 0)) AS stop_hook_duration_ms
  FROM events_raw
  WHERE event_name = 'stop_hooks.completed'
  GROUP BY 1
)
SELECT
  tl.event_date,
  ROUND((SELECT AVG(main_first_chunk_ms - action_started_ms) FROM action_first_chunk afc WHERE afc.event_date = tl.event_date AND afc.main_first_chunk_ms IS NOT NULL), 3) AS submit_to_first_chunk_ms,
  ROUND(AVG(CASE WHEN tl.before_turn_ms IS NOT NULL AND tl.prompt_build_started_ms IS NOT NULL THEN tl.prompt_build_started_ms - tl.before_turn_ms END), 3) AS preprocess_duration_ms,
  ROUND(AVG(CASE WHEN tl.prompt_build_started_ms IS NOT NULL AND tl.prompt_build_completed_ms IS NOT NULL THEN tl.prompt_build_completed_ms - tl.prompt_build_started_ms END), 3) AS prompt_build_duration_ms,
  ROUND(AVG(CASE WHEN tl.api_request_started_ms IS NOT NULL AND tl.api_first_chunk_ms IS NOT NULL THEN tl.api_first_chunk_ms - tl.api_request_started_ms END), 3) AS api_first_chunk_latency_ms,
  ROUND(AVG(CASE WHEN tl.api_request_started_ms IS NOT NULL AND tl.api_completed_ms IS NOT NULL THEN tl.api_completed_ms - tl.api_request_started_ms END), 3) AS api_total_duration_ms,
  ROUND((SELECT AVG(duration_ms) FROM tools t WHERE COALESCE(t.completed_at, t.started_at, t.enqueued_at, '') LIKE tl.event_date || '%'), 3) AS tool_execution_duration_ms,
  ROUND((SELECT AVG(duration_ms) FROM subagents s WHERE COALESCE(s.completed_at, s.spawned_at, '') LIKE tl.event_date || '%'), 3) AS subagent_duration_ms,
  ROUND((SELECT AVG(duration_ms) FROM user_actions ua WHERE ua.event_date = tl.event_date), 3) AS user_action_e2e_duration_ms,
  ROUND(COALESCE(MAX(sd.stop_hook_duration_ms), 0), 3) AS stop_hook_duration_ms
FROM turn_latencies tl
LEFT JOIN stop_hook_durations sd ON sd.event_date = tl.event_date
GROUP BY 1;

CREATE OR REPLACE VIEW metrics_compression_daily AS
WITH per_event AS (
  SELECT
    event_date,
    event_name,
    COALESCE(TRY_CAST(json_extract(payload_json, '$.tokens_saved') AS BIGINT), 0) AS tokens_saved,
    COALESCE(TRY_CAST(json_extract(payload_json, '$.estimated_tokens_before') AS BIGINT), 0) AS estimated_tokens_before,
    COALESCE(TRY_CAST(json_extract(payload_json, '$.estimated_tokens_after') AS BIGINT), 0) AS estimated_tokens_after,
    COALESCE(TRY_CAST(json_extract(payload_json, '$.compacted') AS BOOLEAN), FALSE) AS compacted
  FROM events_raw
  WHERE event_name LIKE 'messages.%'
),
preprocess AS (
  SELECT
    event_date,
    SUM(CASE WHEN event_name = 'messages.preprocess.completed' THEN estimated_tokens_before ELSE 0 END) AS preprocess_tokens_before_total,
    SUM(CASE WHEN event_name = 'messages.preprocess.completed' THEN estimated_tokens_after ELSE 0 END) AS preprocess_tokens_after_total
  FROM per_event
  GROUP BY 1
)
SELECT
  p.event_date,
  p.preprocess_tokens_before_total,
  p.preprocess_tokens_after_total,
  p.preprocess_tokens_before_total - p.preprocess_tokens_after_total AS tokens_saved_total,
  CASE
    WHEN p.preprocess_tokens_before_total = 0 THEN 0
    ELSE ROUND((p.preprocess_tokens_before_total - p.preprocess_tokens_after_total) * 1.0 / p.preprocess_tokens_before_total, 6)
  END AS compression_gain_ratio,
  SUM(CASE WHEN e.event_name = 'messages.tool_result_budget.applied' THEN e.tokens_saved ELSE 0 END) AS tool_result_budget_saved_tokens,
  SUM(CASE WHEN e.event_name = 'messages.history_snip.applied' THEN e.tokens_saved ELSE 0 END) AS history_snip_saved_tokens,
  SUM(CASE WHEN e.event_name = 'messages.microcompact.applied' THEN e.tokens_saved ELSE 0 END) AS microcompact_saved_tokens,
  SUM(CASE WHEN e.event_name = 'messages.autoconpact.completed' THEN e.estimated_tokens_before - e.estimated_tokens_after ELSE 0 END) AS autocompact_saved_tokens,
  ROUND(AVG(CASE WHEN e.event_name = 'messages.autoconpact.completed' AND e.compacted THEN 1.0 ELSE 0.0 END), 6) AS autocompact_trigger_rate,
  CASE WHEN SUM(CASE WHEN e.event_name = 'messages.history_snip.applied' THEN 1 ELSE 0 END) > 0 THEN 1.0 ELSE 0.0 END AS history_snip_gate_on_rate,
  0.0 AS contextCollapse_enabled_gauge,
  0 AS contextCollapse_attempted,
  0 AS contextCollapse_committed
FROM preprocess p
LEFT JOIN per_event e ON e.event_date = p.event_date
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW tool_calls_by_name AS
SELECT
  COALESCE(tool_name, 'unknown') AS tool_name,
  COUNT(*) AS tool_calls,
  ROUND(AVG(CASE WHEN success = TRUE THEN 1.0 ELSE 0.0 END), 6) AS tool_success_rate,
  ROUND(AVG(CASE WHEN success = FALSE THEN 1.0 ELSE 0.0 END), 6) AS tool_failure_rate,
  ROUND(AVG(duration_ms), 3) AS tool_avg_duration_ms,
  ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 3) AS tool_p95_duration_ms
FROM tools
GROUP BY 1;

CREATE OR REPLACE VIEW tool_calls_by_mode AS
SELECT
  COALESCE(json_extract_string(payload_json, '$.mode'), 'unknown') AS tool_mode,
  COUNT(*) AS tool_calls
FROM events_raw
WHERE event_name = 'tool.execution.mode.selected'
GROUP BY 1;

CREATE OR REPLACE VIEW metrics_tools_daily AS
WITH daily_tools AS (
  SELECT
    SUBSTR(COALESCE(completed_at, started_at, enqueued_at, detected_at), 1, 10) AS event_date,
    COUNT(*) AS tool_calls_total,
    ROUND(AVG(CASE WHEN success = TRUE THEN 1.0 ELSE 0.0 END), 6) AS tool_success_rate,
    ROUND(AVG(CASE WHEN success = FALSE THEN 1.0 ELSE 0.0 END), 6) AS tool_failure_rate,
    ROUND(AVG(duration_ms), 3) AS tool_avg_duration_ms,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 3) AS tool_p95_duration_ms
  FROM tools
  GROUP BY 1
)
SELECT
  r.event_date,
  COALESCE(dt.tool_calls_total, 0) AS tool_calls_total,
  COALESCE(dt.tool_success_rate, 0) AS tool_success_rate,
  COALESCE(dt.tool_failure_rate, 0) AS tool_failure_rate,
  COALESCE(dt.tool_avg_duration_ms, 0) AS tool_avg_duration_ms,
  COALESCE(dt.tool_p95_duration_ms, 0) AS tool_p95_duration_ms,
  ROUND((
    SELECT AVG(CASE WHEN event_name = 'tool.context.updated' THEN 1.0 ELSE 0.0 END)
    FROM events_raw er
    WHERE er.event_date = r.event_date AND er.event_name IN ('tool.context.updated', 'turn.started')
  ), 6) AS context_update_rate,
  ROUND((SELECT AVG(tool_call_count) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date), 6) AS tools_per_query,
  ROUND((SELECT AVG(tool_call_count) FROM queries q WHERE SUBSTR(q.started_at, 1, 10) = r.event_date AND q.subagent_id IS NOT NULL), 6) AS tools_per_subagent,
  ROUND((SELECT AVG(CASE WHEN assistant_tool_use_count > 0 THEN CASE WHEN transition_out = 'next_turn' THEN 1.0 ELSE 0.0 END END) FROM turns t WHERE SUBSTR(t.started_at, 1, 10) = r.event_date), 6) AS tool_followup_turn_ratio
FROM daily_rollups r
LEFT JOIN daily_tools dt ON dt.event_date = r.event_date;

CREATE OR REPLACE VIEW terminal_reason_distribution AS
SELECT
  SUBSTR(started_at, 1, 10) AS event_date,
  COALESCE(terminal_reason, 'unknown') AS terminal_reason,
  COUNT(*) AS query_count
FROM queries
GROUP BY 1, 2;

CREATE OR REPLACE VIEW metrics_recovery_daily AS
WITH query_failures AS (
  SELECT
    SUBSTR(started_at, 1, 10) AS event_date,
    COUNT(*) FILTER (WHERE terminal_reason = 'completed') AS completed_queries,
    COUNT(*) FILTER (WHERE terminal_reason IS NOT NULL AND terminal_reason <> 'completed') AS failed_queries
  FROM queries
  GROUP BY 1
),
tool_failure_queries AS (
  SELECT
    SUBSTR(q.started_at, 1, 10) AS event_date,
    COUNT(DISTINCT t.query_id) AS queries_with_failed_tools,
    COUNT(DISTINCT CASE WHEN q.terminal_reason IS NOT NULL AND q.terminal_reason <> 'completed' THEN t.query_id END) AS failed_tool_terminal_queries
  FROM tools t
  LEFT JOIN queries q ON q.query_id = t.query_id
  WHERE t.has_failed
  GROUP BY 1
)
SELECT
  r.event_date,
  SUM(CASE WHEN rec.event_name LIKE '%prompt_too_long%' THEN 1 ELSE 0 END) AS prompt_too_long_recovery_attempts,
  CASE
    WHEN SUM(CASE WHEN rec.event_name LIKE '%prompt_too_long%' THEN 1 ELSE 0 END) = 0 THEN NULL
    ELSE ROUND(AVG(CASE WHEN rec.event_name LIKE '%prompt_too_long%' AND rec.reason = 'completed' THEN 1.0 ELSE 0.0 END), 6)
  END AS prompt_too_long_recovery_success_rate,
  SUM(CASE WHEN rec.event_name LIKE '%max_output_tokens%' THEN 1 ELSE 0 END) AS max_output_tokens_recovery_attempts,
  CASE
    WHEN SUM(CASE WHEN rec.event_name LIKE '%max_output_tokens%' THEN 1 ELSE 0 END) = 0 THEN NULL
    ELSE ROUND(AVG(CASE WHEN rec.event_name LIKE '%max_output_tokens%' AND rec.reason = 'completed' THEN 1.0 ELSE 0.0 END), 6)
  END AS max_output_tokens_recovery_success_rate,
  ROUND(AVG(CASE WHEN er.event_name = 'token_budget.decision' AND json_extract_string(er.payload_json, '$.action') = 'continue' THEN 1.0 ELSE 0.0 END), 6) AS token_budget_continue_rate,
  ROUND(AVG(CASE WHEN er.event_name = 'stop_hooks.completed' AND COALESCE(TRY_CAST(json_extract(er.payload_json, '$.prevent_continuation') AS BOOLEAN), FALSE) THEN 1.0 ELSE 0.0 END), 6) AS stop_hook_block_rate,
  CASE
    WHEN COALESCE(MAX(qf.completed_queries), 0) + COALESCE(MAX(qf.failed_queries), 0) = 0 THEN 0
    ELSE ROUND(COALESCE(MAX(qf.failed_queries), 0) * 1.0 / (COALESCE(MAX(qf.completed_queries), 0) + COALESCE(MAX(qf.failed_queries), 0)), 6)
  END AS api_error_rate,
  CASE
    WHEN COALESCE(MAX(tfq.queries_with_failed_tools), 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(MAX(tfq.failed_tool_terminal_queries), 0) * 1.0 / MAX(tfq.queries_with_failed_tools), 6)
  END AS tool_failure_terminal_rate,
  ROUND(AVG(CASE WHEN er.event_name = 'exporter.failure' THEN 1.0 ELSE 0.0 END), 6) AS exporter_failure_rate,
  ROUND(AVG(CASE WHEN er.event_name = 'dropped_event' THEN 1.0 ELSE 0.0 END), 6) AS dropped_event_rate
FROM daily_rollups r
LEFT JOIN recoveries rec ON rec.ts_wall LIKE r.event_date || '%'
LEFT JOIN events_raw er ON er.event_date = r.event_date AND er.event_name IN ('token_budget.decision', 'stop_hooks.completed', 'exporter.failure', 'dropped_event')
LEFT JOIN query_failures qf ON qf.event_date = r.event_date
LEFT JOIN tool_failure_queries tfq ON tfq.event_date = r.event_date
GROUP BY 1;

CREATE OR REPLACE VIEW system_flags AS
SELECT
  event_date,
  0.0 AS contextCollapse_enabled_gauge,
  0 AS contextCollapse_attempted,
  0 AS contextCollapse_committed,
  CASE
    WHEN SUM(CASE WHEN event_name = 'messages.history_snip.applied' THEN 1 ELSE 0 END) > 0
      THEN '样本中观察到命中'
    ELSE '样本中未观察到命中'
  END AS history_snip_gate_state,
  CASE WHEN SUM(CASE WHEN event_name = 'messages.history_snip.applied' THEN 1 ELSE 0 END) > 0 THEN 1.0 ELSE 0.0 END AS history_snip_gate_on_rate
FROM events_raw
GROUP BY 1;

COMMIT;
`

writeFileSync(sqlPath, sql, "utf8")

console.log(
  JSON.stringify(
    {
      duckdbExe,
      databasePath,
      sqlPath,
      eventsPath,
      events: eventsRawRows.length,
      queries: queryInsertRows.length,
      turns: turnInsertRows.length,
      tools: toolInsertRows.length,
      subagents: subagentInsertRows.length,
      recoveries: recoveryRows.length,
      snapshots: snapshotInsertRows.length,
      usageFacts: usageFactRows.length,
      dailyRollups: dailyRollupRows.length,
    },
    null,
    2,
  ),
)
