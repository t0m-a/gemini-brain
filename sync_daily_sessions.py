#!/usr/bin/env python3
"""
Gemini Brain — Daily Transcript Harvester & Episodic Sync (Layer 2)
===================================================================
Scans local conversation transcripts across all local Gemini surfaces:
  1. Antigravity 2.0  (~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl)
  2. Antigravity CLI  (~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl)
  3. Antigravity IDE  (~/.gemini/antigravity-ide/brain/<uuid>/.system_generated/logs/transcript.jsonl)
  4. Gemini CLI       (~/.gemini/tmp/<project>/chats/session-*.jsonl & *.json)

Cross-references discovered sessions against live `BrainMemoryDO.episodic_logs`
on `https://brain.tsimon.me` and automatically uploads an episodic checkpoint
(`log_episodic_event`) for any session that has not yet been logged, ensuring
100% coverage before the 03:00 AM (07:00 UTC) Llama 3.3 70B nocturnal consolidation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple

import brain_monitor as bm

MCP_ENDPOINT = f"{bm.BRAIN_BASE_URL}/mcp"
STATE_FILE = pathlib.Path.home() / ".gemini" / "brain_synced_sessions.json"

# Automated sidecar prompts to ignore so scheduled maintenance jobs do not self-log noise
IGNORED_PROMPT_PATTERNS = [
    "Rebuild the local static HTML website at G:\\My Drive\\Workspaces\\Obsidian",
    "Run the nightly Gemini Brain session harvester",
    "sync_daily_sessions.py",
]


def clean_user_text(raw: str) -> str:
    """Strip XML wrapper tags and boilerplate context blocks from user prompts."""
    text = raw or ""
    # Extract <USER_REQUEST>...</USER_REQUEST> if present
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, flags=re.DOTALL)
    if m:
        text = m.group(1)
    else:
        # Remove <CONTEXT_SUMMARY>...</CONTEXT_SUMMARY>, <ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>, <session_context>...</session_context>
        text = re.sub(r"<CONTEXT_SUMMARY>.*?</CONTEXT_SUMMARY>", "", text, flags=re.DOTALL)
        text = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", text, flags=re.DOTALL)
        text = re.sub(r"<session_context>.*?</session_context>", "", text, flags=re.DOTALL)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_assistant_text(raw: str) -> str:
    """Compact assistant response text for episodic summary inclusion."""
    text = (raw or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text


def is_ignored_session(user_prompts: List[str]) -> bool:
    if not user_prompts:
        return True
    first = user_prompts[0]
    for pat in IGNORED_PROMPT_PATTERNS:
        if pat.lower() in first.lower():
            return True
    return False


def parse_antigravity_transcript(path: pathlib.Path) -> Tuple[List[str], List[str], Optional[str]]:
    """Return (user_prompts, assistant_responses, iso_date) from an Antigravity transcript.jsonl."""
    user_prompts: List[str] = []
    assistant_responses: List[str] = []
    last_created_at: Optional[str] = None

    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], [], None

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        created_at = obj.get("created_at")
        if isinstance(created_at, str) and created_at:
            last_created_at = created_at

        step_type = obj.get("type", "")
        content = obj.get("content", "")
        if not isinstance(content, str) or not content.strip():
            continue

        if step_type == "USER_INPUT":
            cleaned = clean_user_text(content)
            if cleaned and (not user_prompts or user_prompts[-1] != cleaned):
                user_prompts.append(cleaned)
        elif step_type == "PLANNER_RESPONSE":
            cleaned = clean_assistant_text(content)
            if cleaned and len(cleaned) > 25:
                assistant_responses.append(cleaned)

    iso_date = None
    if last_created_at and len(last_created_at) >= 10:
        iso_date = last_created_at[:10]
    else:
        mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
        iso_date = mtime.strftime("%Y-%m-%d")

    return user_prompts, assistant_responses, iso_date


def extract_text_from_gcli_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def parse_gemini_cli_transcript(path: pathlib.Path) -> Tuple[str, List[str], List[str], Optional[str]]:
    """Return (session_id, user_prompts, assistant_responses, iso_date) from a Gemini CLI chat file."""
    project_slug = path.parent.parent.name
    stem = path.stem  # e.g. session-2026-10-21T02-18-a2a-serv
    session_id = f"gcli-{project_slug}-{stem}"
    user_prompts: List[str] = []
    assistant_responses: List[str] = []
    last_updated: Optional[str] = None

    try:
        raw_text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return session_id, [], [], None

    if not raw_text:
        return session_id, [], [], None

    messages: List[Dict[str, Any]] = []
    if path.suffix == ".json":
        try:
            data = json.loads(raw_text)
            if isinstance(data, dict):
                messages = data.get("messages", [])
                last_updated = data.get("lastUpdated") or data.get("startTime")
        except json.JSONDecodeError:
            pass
    else:
        for line in raw_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            if "lastUpdated" in obj:
                last_updated = obj.get("lastUpdated")
            if "$set" in obj and isinstance(obj["$set"], dict):
                if "messages" in obj["$set"] and isinstance(obj["$set"]["messages"], list):
                    messages = obj["$set"]["messages"]
                if "lastUpdated" in obj["$set"]:
                    last_updated = obj["$set"]["lastUpdated"]
            elif "messages" in obj and isinstance(obj["messages"], list):
                messages = obj["messages"]

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        mtype = str(msg.get("type") or msg.get("role") or "").lower()
        raw_content = extract_text_from_gcli_content(msg.get("content"))
        if not raw_content:
            continue
        if mtype in ("user", "human"):
            cleaned = clean_user_text(raw_content)
            if cleaned and (not user_prompts or user_prompts[-1] != cleaned):
                user_prompts.append(cleaned)
        elif mtype in ("gemini", "model", "assistant"):
            cleaned = clean_assistant_text(raw_content)
            if cleaned and len(cleaned) > 25:
                assistant_responses.append(cleaned)

    iso_date = None
    if isinstance(last_updated, str) and len(last_updated) >= 10:
        iso_date = last_updated[:10]
    else:
        mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
        iso_date = mtime.strftime("%Y-%m-%d")

    return session_id, user_prompts, assistant_responses, iso_date


def build_checkpoint_payload(
    session_id: str,
    client_id: str,
    iso_date: str,
    user_prompts: List[str],
    assistant_responses: List[str],
    source_label: str,
) -> str:
    header = (
        f"Automated Daily Session Checkpoint ({iso_date} | client: {client_id} | "
        f"source: {source_label} | session: {session_id}):"
    )
    req_lines = [f"User Requests ({len(user_prompts)} turns):"]
    for idx, prompt in enumerate(user_prompts[:12], start=1):
        snippet = prompt[:280] + ("..." if len(prompt) > 280 else "")
        req_lines.append(f"  {idx}. {snippet}")

    outcome_lines = ["Key Assistant Outcomes & Findings:"]
    # Take the first response and up to the last 4 responses for high-signal outcome coverage
    selected_responses: List[str] = []
    if len(assistant_responses) <= 4:
        selected_responses = assistant_responses
    else:
        selected_responses = [assistant_responses[0]] + assistant_responses[-3:]

    if not selected_responses:
        outcome_lines.append("  - Session contained user prompts without recorded planner text responses.")
    else:
        for resp in selected_responses:
            snippet = resp[:600] + ("..." if len(resp) > 600 else "")
            outcome_lines.append(f"  - {snippet}")

    payload = "\n".join([header, "\n".join(req_lines), "\n".join(outcome_lines)])
    return payload[:15000]


def call_mcp_log_episodic_event(
    token: str,
    session_id: str,
    client_id: str,
    payload: str,
) -> Optional[int]:
    rpc_body = {
        "jsonrpc": "2.0",
        "id": f"sync-{session_id}",
        "method": "tools/call",
        "params": {
            "name": "log_episodic_event",
            "arguments": {
                "sessionId": session_id,
                "clientId": client_id,
                "eventType": "checkpoint",
                "payload": payload,
            },
        },
    }
    data = json.dumps(rpc_body).encode("utf-8")
    req = urllib.request.Request(
        MCP_ENDPOINT,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "gemini-brain-daily-harvester/1.2.2",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")

    # Handle either direct JSON or SSE data lines
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
                content_list = parsed.get("result", {}).get("content", [])
                for item in content_list:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        inner = json.loads(item["text"])
                        return inner.get("logId")
            except json.JSONDecodeError:
                continue
    return None


def fetch_existing_remote_sessions(token: str, hours: int = 168) -> Set[str]:
    status, res, _ = bm.api_request("GET", f"/audit/logs?hours={hours}&limit=200", token)
    if status != 200 or not isinstance(res, dict):
        return set()
    logs = res.get("episodicLogs", [])
    return {str(row.get("session_id")) for row in logs if row.get("session_id")}


def discover_transcripts(hours: float) -> List[Dict[str, Any]]:
    home = pathlib.Path.home()
    gemini_dir = home / ".gemini"
    cutoff_ts = dt.datetime.now(tz=dt.timezone.utc).timestamp() - (hours * 3600.0)
    discovered: List[Dict[str, Any]] = []

    # 1. Antigravity surfaces (antigravity, antigravity-cli, antigravity-ide)
    agy_surfaces = [
        ("antigravity", "antigravity-win11"),
        ("antigravity-cli", "antigravity-cli-win11"),
        ("antigravity-ide", "antigravity-ide-win11"),
    ]
    for folder_name, client_id in agy_surfaces:
        brain_root = gemini_dir / folder_name / "brain"
        if not brain_root.exists():
            continue
        try:
            session_dirs = list(brain_root.iterdir())
        except OSError:
            continue
        for sdir in session_dirs:
            if not sdir.is_dir() or sdir.name == "tempmediaStorage":
                continue
            tpath = sdir / ".system_generated" / "logs" / "transcript.jsonl"
            if not tpath.exists():
                continue
            try:
                mtime = tpath.stat().st_mtime
            except OSError:
                continue
            if mtime < cutoff_ts:
                continue
            user_prompts, assistant_responses, iso_date = parse_antigravity_transcript(tpath)
            if is_ignored_session(user_prompts):
                continue
            discovered.append(
                {
                    "session_id": sdir.name,
                    "client_id": client_id,
                    "source_label": folder_name,
                    "path": str(tpath),
                    "mtime": mtime,
                    "iso_date": iso_date or dt.date.today().isoformat(),
                    "user_prompts": user_prompts,
                    "assistant_responses": assistant_responses,
                }
            )

    # 2. Gemini CLI (~/.gemini/tmp/<project>/chats/session-*.jsonl & *.json)
    tmp_root = gemini_dir / "tmp"
    if tmp_root.exists():
        try:
            proj_dirs = list(tmp_root.iterdir())
        except OSError:
            proj_dirs = []
        for pdir in proj_dirs:
            chats_dir = pdir / "chats"
            if not chats_dir.exists() or not chats_dir.is_dir():
                continue
            try:
                chat_files = list(chats_dir.glob("session-*.*"))
            except OSError:
                continue
            for cfile in chat_files:
                if cfile.suffix not in (".jsonl", ".json"):
                    continue
                try:
                    mtime = cfile.stat().st_mtime
                except OSError:
                    continue
                if mtime < cutoff_ts:
                    continue
                session_id, user_prompts, assistant_responses, iso_date = parse_gemini_cli_transcript(cfile)
                if is_ignored_session(user_prompts):
                    continue
                discovered.append(
                    {
                        "session_id": session_id,
                        "client_id": "gemini-cli-win11",
                        "source_label": f"gemini-cli/{pdir.name}",
                        "path": str(cfile),
                        "mtime": mtime,
                        "iso_date": iso_date or dt.date.today().isoformat(),
                        "user_prompts": user_prompts,
                        "assistant_responses": assistant_responses,
                    }
                )

    discovered.sort(key=lambda x: x["mtime"])
    return discovered


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Harvest daily Antigravity & Gemini CLI transcripts into BrainMemoryDO episodic_logs."
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=24.0,
        help="Lookback window in hours for modified local transcripts (default: 24).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect and preview unlogged sessions without uploading to BrainMemoryDO.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output machine-readable JSON summary.",
    )
    args = parser.parse_args()

    token = bm.load_bearer_token()
    existing_sessions = fetch_existing_remote_sessions(token, hours=max(168, int(args.hours) + 24))
    candidates = discover_transcripts(hours=args.hours)

    uploaded: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for item in candidates:
        sid = item["session_id"]
        if sid in existing_sessions:
            skipped.append(
                {
                    "session_id": sid,
                    "client_id": item["client_id"],
                    "source": item["source_label"],
                    "reason": "already_in_episodic_logs",
                }
            )
            continue

        payload = build_checkpoint_payload(
            session_id=sid,
            client_id=item["client_id"],
            iso_date=item["iso_date"],
            user_prompts=item["user_prompts"],
            assistant_responses=item["assistant_responses"],
            source_label=item["source_label"],
        )

        if args.dry_run:
            uploaded.append(
                {
                    "session_id": sid,
                    "client_id": item["client_id"],
                    "source": item["source_label"],
                    "turns": len(item["user_prompts"]),
                    "dry_run": True,
                    "payload_preview": payload[:300],
                }
            )
            continue

        log_id = call_mcp_log_episodic_event(
            token=token,
            session_id=sid,
            client_id=item["client_id"],
            payload=payload,
        )
        existing_sessions.add(sid)
        uploaded.append(
            {
                "session_id": sid,
                "client_id": item["client_id"],
                "source": item["source_label"],
                "turns": len(item["user_prompts"]),
                "log_id": log_id,
            }
        )

    summary = {
        "ok": True,
        "lookbackHours": args.hours,
        "discoveredCount": len(candidates),
        "uploadedCount": len(uploaded),
        "skippedAlreadyLoggedCount": len(skipped),
        "uploaded": uploaded,
        "skipped": skipped,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(
            f"[gemini-brain-sync] Discovered {len(candidates)} active session(s) in last {args.hours}h: "
            f"{len(uploaded)} uploaded, {len(skipped)} already logged."
        )
        for u in uploaded:
            print(
                f"  + Uploaded {u['source']} session {u['session_id']} "
                f"({u['turns']} turns) -> log_id={u.get('log_id')}"
            )
        for s in skipped:
            print(f"  = Skipped {s['source']} session {s['session_id']} ({s['reason']})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
