"""Export the active conversation from Claude Code's local transcript journal."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Entry:
    """The parent link and visible payload needed to reconstruct a journal entry."""

    parent: str | None
    role: str
    content: str | list | None
    response_id: str | None
    boundary: bool


def _visible_content(row: dict, local_commands: set[str]) -> str | list | None:
    """Keep the original conversation content, without transport and instruction rows."""
    role = row["type"]
    if role not in ("user", "assistant"):
        return None
    message = row.get("message", {})
    if not isinstance(message, dict):
        raise ValueError("Unsupported message record in the Claude Code transcript.")
    content = message.get("content")
    prompt_id = row.get("promptId")
    # The CLI groups the local-command caveat, invocation and stdout under one prompt ID.
    if (row.get("isMeta") and isinstance(prompt_id, str) and isinstance(content, str)
            and content.startswith("<local-command-caveat>")):
        local_commands.add(prompt_id)
    if row.get("isMeta") or row.get("isCompactSummary") or row.get("isVisibleInTranscriptOnly"):
        return None
    if message.get("model") == "<synthetic>":
        return None
    if prompt_id in local_commands and not row.get("promptSource"):
        return None
    # Retain tool results even if the CLI authored the envelope that delivered them.
    origin = row.get("origin")
    origin_kind = origin.get("kind") if isinstance(origin, dict) else origin
    machine_authored = row.get("rowSource") == "harness" or origin_kind in ("plugin", "hook", "engine")
    if role == "user" and machine_authored:
        if not isinstance(content, list):
            return None
        content = [block for block in content if isinstance(block, dict) and block.get("type") == "tool_result"]
    if isinstance(content, str):
        return content
    if not isinstance(content, list) or any(not isinstance(block, dict) for block in content):
        raise ValueError("Unsupported conversation payload in the Claude Code transcript.")
    # Thinking and redacted thinking are private model blocks, separate from the reply.
    return [block for block in content if block.get("type") not in ("thinking", "redacted_thinking")] or None


def _read_entries(transcript: Path) -> tuple[dict[str, Entry], str | None]:
    """Index the main session's parent links and discard unrelated API request records."""
    entries: dict[str, Entry] = {}
    preserved_tails: dict[str, str] = {}
    local_commands: set[str] = set()
    latest = None
    with transcript.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError as error:
                raise ValueError(f"Invalid transcript JSON at line {line_number}. Retry after Claude finishes writing.") from error
            if not isinstance(row, dict):
                raise ValueError(f"Invalid transcript record at line {line_number}.")
            uid = row.get("uuid")
            if not isinstance(uid, str) or "parentUuid" not in row or row.get("isSidechain") or row.get("teamName"):
                continue
            role = row.get("type")
            parent = row["parentUuid"]
            boundary = role == "system" and row.get("subtype") == "compact_boundary"
            if boundary:
                # The normal parent starts a fresh context. Its logical parent leads back to the originals.
                parent = row.get("logicalParentUuid") or parent
            if uid in entries:
                # Compaction can replay a retained entry under the same UUID with a new parent.
                continue
            if parent in preserved_tails:
                parent = preserved_tails[parent]
            if boundary:
                # Some continuations attach to the kept tail instead of the summary after a compact.
                segment = (row.get("compactMetadata") or {}).get("preservedSegment") or {}
                if segment.get("tailUuid"):
                    preserved_tails[segment["tailUuid"]] = uid
            content = _visible_content(row, local_commands)
            response_id = row.get("message", {}).get("id") if role == "assistant" else None
            entries[uid] = Entry(parent, role, content, response_id, boundary)
            if role in ("user", "assistant") or boundary:
                latest = uid
    return entries, latest


def _active_branch(entries: dict[str, Entry], tip: str) -> set[str]:
    """Follow the current conversation through rewinds and across each compaction."""
    active: set[str] = set()
    uid = tip
    while uid is not None:
        entry = entries.get(uid)
        if entry is None:
            raise ValueError("The active conversation references history missing from the transcript.")
        if uid in active:
            raise ValueError("The Claude Code transcript contains a circular parent link.")
        if entry.boundary and not entry.parent:
            raise ValueError("The transcript does not link to its pre-compaction history.")
        active.add(uid)
        uid = entry.parent
    return active


def _tool_ids(content: str | list | None, kind: str, key: str) -> set[str]:
    """Identify call/result pairs, including tools whose outputs were recorded in parallel."""
    if not isinstance(content, list):
        return set()
    return {block[key] for block in content if block.get("type") == kind and isinstance(block.get(key), str)}


def export_history(transcript: Path, output: Path, tip: str | None = None) -> int:
    """Write chronological user, assistant, and tool content for the launcher's handoff.

    A live message UUID selects the active branch when provided. If the transcript
    or branch cannot be read in full, raise ValueError or OSError before moving.
    Returns the number of exported messages.
    """
    entries, latest = _read_entries(transcript)
    tip = tip or latest
    if not tip:
        raise ValueError("The session has no saved conversation to move.")
    active = _active_branch(entries, tip)
    responses = {entries[uid].response_id for uid in active if entries[uid].response_id}
    calls: set[str] = set()
    answered: set[str] = set()
    for uid, entry in entries.items():
        # One model response can have multiple assistant rows, one per parallel tool call.
        if entry.response_id in responses:
            active.add(uid)
        if uid in active:
            calls.update(_tool_ids(entry.content, "tool_use", "id"))
            answered.update(_tool_ids(entry.content, "tool_result", "tool_use_id"))
        if uid == tip:
            break

    count = 0
    with output.open("w", encoding="utf-8") as stream:
        for uid, entry in entries.items():
            content = entry.content
            if uid not in active:
                # Parallel results can be siblings of the continued branch. Recover only its missing results.
                if entry.role == "user" and isinstance(content, list):
                    content = [block for block in content if block.get("type") == "tool_result"
                               and block.get("tool_use_id") in calls and block.get("tool_use_id") not in answered]
                    answered.update(_tool_ids(content, "tool_result", "tool_use_id"))
                else:
                    content = None
            if content is not None and content != []:
                record = {"role": entry.role, "content": content}
                stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                count += 1
            if uid == tip:
                break
    if not count:
        raise ValueError("The session has no saved conversation to move.")
    return count
