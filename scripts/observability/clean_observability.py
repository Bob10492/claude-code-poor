from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
OBSERVABILITY_DIR = REPO_ROOT / ".observability"
EVENT_GLOB = "events-*.jsonl"
SNAPSHOTS_DIR = OBSERVABILITY_DIR / "snapshots"
ARCHIVE_ROOT = REPO_ROOT / ".observability_archive" / "2026-04-19"
ARCHIVE_EVENTS_DIR = ARCHIVE_ROOT / "events"
ARCHIVE_SNAPSHOTS_DIR = ARCHIVE_ROOT / "snapshots"
PRE_REPORT_PATH = REPO_ROOT / "ObservrityTask" / "观测数据清洗前清单.md"
POST_REPORT_PATH = REPO_ROOT / "ObservrityTask" / "观测数据清洗后校验报告.md"

KEEP_DAY = date(2026, 4, 20)
ARCHIVE_CUTOFF_DAY = date(2026, 4, 19)
SNAPSHOT_REF_PREFIX = ".observability/snapshots/"
SNAPSHOT_REF_RE = re.compile(r"\.observability/snapshots/[^\s\"']+\.json")


@dataclass
class ParsedEvent:
    obj: dict[str, Any]
    source_file: Path
    day: date | None
    snapshot_refs: set[str]


@dataclass
class FilePartition:
    source_file: Path
    keep_events: list[ParsedEvent]
    archive_events: list[ParsedEvent]


def skip_whitespace(text: str, index: int) -> int:
    length = len(text)
    while index < length and text[index].isspace():
        index += 1
    return index


def parse_concatenated_json(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    index = 0
    objects: list[dict[str, Any]] = []
    errors: list[str] = []

    while True:
      index = skip_whitespace(text, index)
      if index >= len(text):
          break
      try:
          obj, next_index = decoder.raw_decode(text, index)
      except json.JSONDecodeError as exc:
          errors.append(f"{path.name}: JSON decode failed at char {index}: {exc}")
          break
      if not isinstance(obj, dict):
          errors.append(f"{path.name}: top-level object at char {index} is not a JSON object")
      else:
          objects.append(obj)
      index = next_index

    return objects, errors


def extract_day(obj: dict[str, Any]) -> date | None:
    raw = obj.get("ts_wall")
    if not isinstance(raw, str) or len(raw) < 10:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def find_snapshot_refs(value: Any) -> set[str]:
    refs: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, str):
            refs.update(SNAPSHOT_REF_RE.findall(node))
            return
        if isinstance(node, dict):
            for child in node.values():
                walk(child)
            return
        if isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    return refs


def snapshot_ref_to_path(ref: str) -> Path:
    if not ref.startswith(SNAPSHOT_REF_PREFIX):
        raise ValueError(f"Unexpected snapshot ref: {ref}")
    return REPO_ROOT / Path(ref.replace("/", "\\"))


def format_event_objects(events: list[ParsedEvent]) -> str:
    chunks = [json.dumps(event.obj, ensure_ascii=False, indent=2) for event in events]
    return "\n".join(chunks) + ("\n" if chunks else "")


def collect_inventory() -> tuple[list[ParsedEvent], dict[Path, list[ParsedEvent]], list[str]]:
    all_events: list[ParsedEvent] = []
    events_by_file: dict[Path, list[ParsedEvent]] = {}
    parse_errors: list[str] = []

    for path in sorted(OBSERVABILITY_DIR.glob(EVENT_GLOB)):
        objects, errors = parse_concatenated_json(path)
        parse_errors.extend(errors)
        parsed = [
            ParsedEvent(
                obj=obj,
                source_file=path,
                day=extract_day(obj),
                snapshot_refs=find_snapshot_refs(obj),
            )
            for obj in objects
        ]
        events_by_file[path] = parsed
        all_events.extend(parsed)

    return all_events, events_by_file, parse_errors


def event_day_label(day: date | None) -> str:
    return day.isoformat() if day else "<missing>"


def build_pre_report(
    all_events: list[ParsedEvent],
    events_by_file: dict[Path, list[ParsedEvent]],
    parse_errors: list[str],
) -> str:
    today_events = [event for event in all_events if event.day == KEEP_DAY]
    older_events = [event for event in all_events if event.day is None or event.day < KEEP_DAY]
    today_snapshot_refs = sorted({ref for event in today_events for ref in event.snapshot_refs})
    older_snapshot_refs = sorted({ref for event in older_events for ref in event.snapshot_refs})
    all_snapshot_paths = sorted(path for path in SNAPSHOTS_DIR.iterdir() if path.is_file())
    all_snapshot_refs = {
        f"{SNAPSHOT_REF_PREFIX}{path.name}".replace("\\", "/") for path in all_snapshot_paths
    }
    older_exclusive_snapshot_refs = sorted(set(older_snapshot_refs) - set(today_snapshot_refs))
    unreferenced_snapshot_refs = sorted(all_snapshot_refs - set(today_snapshot_refs) - set(older_snapshot_refs))

    lines = [
        "# 观测数据清洗前清单",
        "",
        f"- 扫描日期：{KEEP_DAY.isoformat()}",
        f"- 目标保留日：{KEEP_DAY.isoformat()}",
        f"- 归档截止日：{ARCHIVE_CUTOFF_DAY.isoformat()} 及更早",
        "",
        "## Event 文件",
        "",
        "| 文件 | 事件数 | 日期范围 |",
        "|---|---:|---|",
    ]

    for path, events in sorted(events_by_file.items()):
        days = sorted({event_day_label(event.day) for event in events})
        day_range = f"{days[0]} -> {days[-1]}" if days else "<empty>"
        lines.append(f"| `{path.relative_to(REPO_ROOT).as_posix()}` | {len(events)} | {day_range} |")

    lines.extend(
        [
            "",
            "## 汇总",
            "",
            f"- 今日事件总数：{len(today_events)}",
            f"- 昨天及更早事件总数：{len(older_events)}",
            f"- snapshots 总数：{len(all_snapshot_paths)}",
            f"- 今日事件引用的 snapshot 数：{len(today_snapshot_refs)}",
            f"- 昨天及更早事件独占的 snapshot 数：{len(older_exclusive_snapshot_refs)}",
            f"- 无引用 snapshot 数：{len(unreferenced_snapshot_refs)}",
            "",
            "## 解析状态",
            "",
            f"- event 文件解析错误数：{len(parse_errors)}",
        ]
    )

    if parse_errors:
        lines.extend(["", "### 解析错误", ""])
        lines.extend(f"- {error}" for error in parse_errors)

    lines.extend(
        [
            "",
            "## 结论",
            "",
            f"- 今日保留基线将以 `{KEEP_DAY.isoformat()}` 事件为准。",
            f"- 计划归档的旧快照数量：{len(older_exclusive_snapshot_refs) + len(unreferenced_snapshot_refs)}",
            "- 快照清洗以事件引用关系为准，不按文件名日期粗删。",
        ]
    )
    return "\n".join(lines) + "\n"


def partition_events(events_by_file: dict[Path, list[ParsedEvent]]) -> list[FilePartition]:
    partitions: list[FilePartition] = []
    for source_file, events in sorted(events_by_file.items()):
        keep_events = [event for event in events if event.day == KEEP_DAY]
        archive_events = [event for event in events if event.day is None or event.day < KEEP_DAY]
        partitions.append(
            FilePartition(
                source_file=source_file,
                keep_events=keep_events,
                archive_events=archive_events,
            )
        )
    return partitions


def ensure_archive_dirs() -> None:
    ARCHIVE_EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def archive_events(partitions: list[FilePartition]) -> tuple[list[str], list[str]]:
    actions: list[str] = []
    retained_files: list[str] = []
    ensure_archive_dirs()

    for partition in partitions:
        src = partition.source_file
        archive_target = ARCHIVE_EVENTS_DIR / src.name

        if partition.keep_events and not partition.archive_events:
            retained_files.append(src.relative_to(REPO_ROOT).as_posix())
            actions.append(f"保留 `{src.relative_to(REPO_ROOT).as_posix()}` 原文件")
            continue

        if partition.archive_events and not partition.keep_events:
            if archive_target.exists():
                archive_target.unlink()
            shutil.move(str(src), str(archive_target))
            actions.append(
                f"整文件归档 `{src.relative_to(REPO_ROOT).as_posix()}` -> `{archive_target.relative_to(REPO_ROOT).as_posix()}`"
            )
            continue

        if partition.keep_events and partition.archive_events:
            archive_target.write_text(format_event_objects(partition.archive_events), encoding="utf-8")
            src.write_text(format_event_objects(partition.keep_events), encoding="utf-8")
            retained_files.append(src.relative_to(REPO_ROOT).as_posix())
            actions.append(
                f"拆分混合文件 `{src.relative_to(REPO_ROOT).as_posix()}`：保留 {len(partition.keep_events)} 条，归档 {len(partition.archive_events)} 条"
            )

    return actions, retained_files


def archive_snapshots(keep_snapshot_refs: set[str]) -> tuple[list[str], list[str]]:
    actions: list[str] = []
    retained_snapshots: list[str] = []
    ensure_archive_dirs()

    for path in sorted(SNAPSHOTS_DIR.iterdir()):
        if not path.is_file():
            continue
        ref = f"{SNAPSHOT_REF_PREFIX}{path.name}"
        if ref in keep_snapshot_refs:
            retained_snapshots.append(path.relative_to(REPO_ROOT).as_posix())
            continue
        target = ARCHIVE_SNAPSHOTS_DIR / path.name
        if target.exists():
            target.unlink()
        shutil.move(str(path), str(target))
        actions.append(
            f"归档 snapshot `{path.relative_to(REPO_ROOT).as_posix()}` -> `{target.relative_to(REPO_ROOT).as_posix()}`"
        )

    return actions, retained_snapshots


def validate_retained_state() -> dict[str, Any]:
    retained_events, retained_by_file, parse_errors = collect_inventory()
    retained_today_events = [event for event in retained_events if event.day == KEEP_DAY]
    retained_snapshot_refs = {ref for event in retained_today_events for ref in event.snapshot_refs}
    retained_snapshot_paths = sorted(path for path in SNAPSHOTS_DIR.iterdir() if path.is_file())
    retained_snapshot_ref_set = {
        f"{SNAPSHOT_REF_PREFIX}{path.name}".replace("\\", "/") for path in retained_snapshot_paths
    }

    missing_snapshot_refs = sorted(retained_snapshot_refs - retained_snapshot_ref_set)
    orphan_snapshot_refs = sorted(retained_snapshot_ref_set - retained_snapshot_refs)
    orphan_event_count = sum(
        1 for event in retained_today_events if any(ref not in retained_snapshot_ref_set for ref in event.snapshot_refs)
    )
    core_events = {
        "input.process.started",
        "prompt.build.completed",
        "api.request.started",
        "api.stream.completed",
    }
    present_core_events = {event.obj.get("event") for event in retained_today_events}

    return {
        "retained_events": retained_today_events,
        "retained_by_file": retained_by_file,
        "parse_errors": parse_errors,
        "retained_snapshot_paths": retained_snapshot_paths,
        "missing_snapshot_refs": missing_snapshot_refs,
        "orphan_snapshot_refs": orphan_snapshot_refs,
        "orphan_event_count": orphan_event_count,
        "core_chain_complete": core_events.issubset(present_core_events),
        "present_core_events": sorted(event for event in present_core_events if isinstance(event, str)),
    }


def build_post_report(
    validation: dict[str, Any],
    event_actions: list[str],
    snapshot_actions: list[str],
    retained_event_files: list[str],
    retained_snapshot_files: list[str],
) -> str:
    etl_ready = (
        not validation["parse_errors"]
        and not validation["missing_snapshot_refs"]
        and validation["orphan_event_count"] == 0
    )

    lines = [
        "# 观测数据清洗后校验报告",
        "",
        f"- 基线日期：{KEEP_DAY.isoformat()}",
        f"- 是否可作为新基线继续做 ETL：{'是' if etl_ready else '否'}",
        "",
        "## 校验结果",
        "",
        f"- 保留事件数：{len(validation['retained_events'])}",
        f"- 保留 snapshot 数：{len(validation['retained_snapshot_paths'])}",
        f"- 缺失 snapshot 引用数：{len(validation['missing_snapshot_refs'])}",
        f"- orphan event 数：{validation['orphan_event_count']}",
        f"- orphan snapshot 数：{len(validation['orphan_snapshot_refs'])}",
        f"- 核心链路事件是否齐备：{'是' if validation['core_chain_complete'] else '否'}",
        "",
        "## 保留文件",
        "",
        "### 今日基线 event 文件",
        "",
    ]
    lines.extend(f"- `{path}`" for path in retained_event_files)
    lines.extend(["", "### 今日基线 snapshot 文件", ""])
    lines.extend(f"- `{path}`" for path in retained_snapshot_files)

    lines.extend(["", "## 归档位置", ""])
    lines.append(f"- 旧 event 归档目录：`{ARCHIVE_EVENTS_DIR.relative_to(REPO_ROOT).as_posix()}`")
    lines.append(f"- 旧 snapshot 归档目录：`{ARCHIVE_SNAPSHOTS_DIR.relative_to(REPO_ROOT).as_posix()}`")

    lines.extend(["", "## 执行动作", ""])
    lines.extend(f"- {action}" for action in event_actions)
    lines.extend(f"- {action}" for action in snapshot_actions)

    lines.extend(["", "## 解析与引用检查", ""])
    lines.append(f"- event 文件解析错误数：{len(validation['parse_errors'])}")
    if validation["parse_errors"]:
        lines.extend(f"- {error}" for error in validation["parse_errors"])
    lines.append(f"- 缺失 snapshot_ref：{len(validation['missing_snapshot_refs'])}")
    for ref in validation["missing_snapshot_refs"]:
        lines.append(f"- 缺失：`{ref}`")
    lines.append(f"- orphan snapshot：{len(validation['orphan_snapshot_refs'])}")
    for ref in validation["orphan_snapshot_refs"]:
        lines.append(f"- orphan：`{ref}`")

    lines.extend(["", "## 结论", ""])
    if etl_ready:
        lines.append("- 清洗后的今日事件与快照引用关系闭合，可以作为新的 ETL / 指标 / trace reader / dashboard 基线。")
    else:
        lines.append("- 当前仍存在解析或引用问题，不能直接进入 ETL。")
    return "\n".join(lines) + "\n"


def main() -> None:
    all_events, events_by_file, parse_errors = collect_inventory()
    PRE_REPORT_PATH.write_text(
        build_pre_report(all_events, events_by_file, parse_errors),
        encoding="utf-8",
    )

    keep_snapshot_refs = {
        ref for event in all_events if event.day == KEEP_DAY for ref in event.snapshot_refs
    }
    partitions = partition_events(events_by_file)
    event_actions, retained_event_files = archive_events(partitions)
    snapshot_actions, retained_snapshot_files = archive_snapshots(keep_snapshot_refs)

    validation = validate_retained_state()
    POST_REPORT_PATH.write_text(
        build_post_report(
            validation,
            event_actions,
            snapshot_actions,
            retained_event_files,
            retained_snapshot_files,
        ),
        encoding="utf-8",
    )

    print("Pre-report:", PRE_REPORT_PATH.relative_to(REPO_ROOT).as_posix())
    print("Post-report:", POST_REPORT_PATH.relative_to(REPO_ROOT).as_posix())
    print("Archived events dir:", ARCHIVE_EVENTS_DIR.relative_to(REPO_ROOT).as_posix())
    print("Archived snapshots dir:", ARCHIVE_SNAPSHOTS_DIR.relative_to(REPO_ROOT).as_posix())


if __name__ == "__main__":
    main()
