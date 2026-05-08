import type { ArtifactRecord, PhaseRecord, RichToolCall } from "./deep_action_types"

const FILE_PATTERN =
  /([A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/])?[\w .-]+(?:[\\/][\w .-]+)*\.(?:docx|pptx|txt|json|py|js|ts|ps1|csv|md|xml|html|png|jpg|jpeg|svg|pdf|xlsx|output))/giu

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/\\/gu, "/")
    .replace(/^([A-Za-z]:)\/+/u, "$1/")
    .replace(/([^:])\/{2,}/gu, "$1/")
}

function isLikelyPath(path: string): boolean {
  const normalized = normalizePath(path)
  if (!normalized) return false
  if (/[{}<>]/u.test(normalized)) return false
  if (!/\.[A-Za-z0-9]{1,8}$/u.test(normalized)) return false
  if (/^[A-Za-z]:$/u.test(normalized)) return false
  if (normalized.startsWith("/") && normalized.split("/").length < 3) return false
  return true
}

function extractPaths(text: string): string[] {
  return unique(
    [...text.matchAll(FILE_PATTERN)]
      .map(match => normalizePath(match[1] ?? ""))
      .filter(isLikelyPath),
  )
}

function classifyArtifact(path: string): string {
  const lowered = normalizePath(path).toLowerCase()
  if (/\.(py|js|ts|ps1)$/u.test(lowered)) return "script"
  if (/\.(pptx)$/u.test(lowered)) return "final"
  if (/\.(docx|pdf|txt)$/u.test(lowered)) return "input"
  if (/\.(png|jpg|jpeg|svg)$/u.test(lowered)) return "media"
  if (/\.(md|csv|json|xml|html|xlsx|output)$/u.test(lowered)) return "intermediate"
  return "other"
}

function toolTouchesArtifact(tool: RichToolCall, path: string): boolean {
  return tool.touched_files.includes(path) || tool.produced_files.includes(path) || tool.result_files.includes(path)
}

export function enrichToolPaths(tools: RichToolCall[]): RichToolCall[] {
  return tools.map(tool => {
    const discovered = extractPaths(
      [
        tool.command_or_path,
        tool.input_summary,
        tool.output_summary,
        tool.stdout_summary,
        tool.stderr_summary,
        tool.result_summary_rich,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    const touched = unique([...tool.touched_files, ...discovered].map(normalizePath).filter(isLikelyPath))
    const produced = unique(
      [...tool.produced_files, ...tool.result_files]
        .map(normalizePath)
        .filter(isLikelyPath),
    )
    const resultFiles = unique([...tool.result_files, ...discovered].map(normalizePath).filter(isLikelyPath))
    return {
      ...tool,
      touched_files: touched,
      produced_files: produced,
      result_files: resultFiles,
    }
  })
}

export function buildArtifactChain(
  tools: RichToolCall[],
  phasesByToolId: Map<string, PhaseRecord>,
): ArtifactRecord[] {
  const artifacts = new Map<string, ArtifactRecord>()

  for (const tool of tools) {
    const phase = phasesByToolId.get(tool.tool_call_id)
    const phaseId = phase?.phase_id ?? "unknown"
    const paths = unique([...tool.touched_files, ...tool.produced_files, ...tool.result_files].map(normalizePath).filter(isLikelyPath))
    for (const path of paths) {
      const existing = artifacts.get(path)
      const produced = tool.produced_files.includes(path) || tool.result_files.includes(path)
      if (!existing) {
        artifacts.set(path, {
          artifact_path: path,
          artifact_type: classifyArtifact(path),
          first_seen_phase: phaseId,
          created_by_tool: produced ? tool.tool_name : "",
          created_by_tool_call_id: produced ? tool.tool_call_id : null,
          created_by_phase_id: produced ? phaseId : null,
          modified_by_tools: toolTouchesArtifact(tool, path) ? [tool.tool_name] : [],
          modified_by_tool_call_ids: toolTouchesArtifact(tool, path) ? [tool.tool_call_id] : [],
          phase_ids: phaseId ? [phaseId] : [],
          evidence_refs: [...tool.evidence_refs],
        })
        continue
      }
      if (!existing.created_by_tool && produced) {
        existing.created_by_tool = tool.tool_name
        existing.created_by_tool_call_id = tool.tool_call_id
        existing.created_by_phase_id = phaseId
      }
      if (toolTouchesArtifact(tool, path)) {
        existing.modified_by_tools = unique([...existing.modified_by_tools, tool.tool_name])
        existing.modified_by_tool_call_ids = unique([...existing.modified_by_tool_call_ids, tool.tool_call_id])
      }
      existing.phase_ids = unique([...existing.phase_ids, phaseId])
      existing.evidence_refs = unique([...existing.evidence_refs, ...tool.evidence_refs])
    }
  }

  return [...artifacts.values()].sort((left, right) => left.artifact_path.localeCompare(right.artifact_path))
}
