import { appendFile, mkdir, writeFile } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join, relative } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  getSessionId,
} from '../bootstrap/state.js'
import { jsonStringify } from '../utils/slowOperations.js'

export const HARNESS_SCHEMA_VERSION = '2026-04-19'

type HarnessLevel = 'debug' | 'info' | 'warning' | 'error'

export type HarnessSnapshotRef = {
  snapshot_ref: string
  bytes: number
  sha256: string
  redaction_state: 'raw' | 'redacted' | 'unknown'
}

export type HarnessEventInput = {
  event: string
  component: string
  level?: HarnessLevel
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
  payload?: Record<string, unknown>
}

let writeChain: Promise<void> = Promise.resolve()
let ensuredDirs: Promise<void> | null = null

function getObservabilityDir(): string {
  return join(getOriginalCwd(), '.observability')
}

function getSnapshotsDir(): string {
  return join(getObservabilityDir(), 'snapshots')
}

async function ensureObservabilityDirs(): Promise<void> {
  if (!ensuredDirs) {
    ensuredDirs = Promise.all([
      mkdir(getObservabilityDir(), { recursive: true }),
      mkdir(getSnapshotsDir(), { recursive: true }),
    ]).then(() => undefined)
  }
  await ensuredDirs
}

function getEventLogPath(now: Date): string {
  const yyyymmdd = now.toISOString().slice(0, 10).replaceAll('-', '')
  return join(getObservabilityDir(), `events-${yyyymmdd}.jsonl`)
}

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(task, task)
  return writeChain
}

function stableStringify(value: unknown): string {
  const result = jsonStringify(value, null, 2)
  return result === undefined ? 'null' : result
}

function digestSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function toSnapshotRef(absolutePath: string): string {
  const rel = relative(getOriginalCwd(), absolutePath).replaceAll('\\', '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

export async function storeHarnessSnapshot(
  label: string,
  data: unknown,
  options?: {
    ext?: 'json' | 'txt'
    redaction_state?: HarnessSnapshotRef['redaction_state']
  },
): Promise<HarnessSnapshotRef> {
  await ensureObservabilityDirs()
  const ext = options?.ext ?? 'json'
  const redaction_state = options?.redaction_state ?? 'raw'
  const id = `${Date.now()}-${randomUUID()}-${label}.${ext}`
  const absolutePath = join(getSnapshotsDir(), id)
  const content =
    ext === 'json'
      ? stableStringify(data)
      : typeof data === 'string'
        ? data
        : stableStringify(data)
  const bytes = Buffer.byteLength(content, 'utf8')
  const sha256 = digestSha256(content)

  await enqueueWrite(async () => {
    await writeFile(absolutePath, content, 'utf8')
  })

  return {
    snapshot_ref: toSnapshotRef(absolutePath),
    bytes,
    sha256,
    redaction_state,
  }
}

export async function emitHarnessEvent(
  input: HarnessEventInput,
): Promise<void> {
  const now = new Date()
  const line = stableStringify({
    schema_version: HARNESS_SCHEMA_VERSION,
    ts_wall: now.toISOString(),
    ts_mono_ms: Math.round(performance.now()),
    level: input.level ?? 'info',
    event: input.event,
    component: input.component,
    session_id: input.session_id ?? getSessionId(),
    conversation_id: input.conversation_id ?? input.session_id ?? getSessionId(),
    user_action_id: input.user_action_id ?? null,
    query_id: input.query_id ?? null,
    turn_id: input.turn_id ?? null,
    loop_iter: input.loop_iter ?? null,
    parent_turn_id: input.parent_turn_id ?? null,
    subagent_id: input.subagent_id ?? null,
    subagent_type: input.subagent_type ?? null,
    subagent_reason: input.subagent_reason ?? null,
    subagent_trigger_kind: input.subagent_trigger_kind ?? null,
    subagent_trigger_detail: input.subagent_trigger_detail ?? null,
    query_source: input.query_source ?? null,
    request_id: input.request_id ?? null,
    tool_call_id: input.tool_call_id ?? null,
    span_id: input.span_id ?? null,
    parent_span_id: input.parent_span_id ?? null,
    cwd: input.cwd ?? getCwdState(),
    git_branch: input.git_branch ?? null,
    build_version: input.build_version ?? (MACRO.VERSION ?? 'unknown'),
    payload: input.payload ?? {},
  })

  await ensureObservabilityDirs()
  await enqueueWrite(async () => {
    await appendFile(getEventLogPath(now), `${line}\n`, 'utf8')
  })
}
