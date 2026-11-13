#!/usr/bin/env python3
"""
File: brain_monitor.py
Purpose: Cross-Platform Terminal Audit, Diff, Rollback, Re-Index & Morning Hydration CLI
         for https://brain.tsimon.me (Windows 11 PowerShell/CMD & Debian 13 Raspberry Pi 5).

Capabilities (Combining Option 2 MCP Pull + Option 3 Audit Control in Terminal):
  - summary   : Overnight dashboard (mutations by client/op/namespace, ADRs, episodic queue)
  - diff      : Colored unified before/after diffs of modified or inserted facts
  - logs      : View 03:00 AM nocturnal consolidation digests & raw episodic logs (or --consolidate now)
  - rollback  : Atomically revert a mutation by mutation_id or memory_id & re-sync Vectorize
  - reindex   : Rebuild SQLite FTS5 BM25 index & re-embed 1024-dim bge-m3 vectors in Vectorize
  - hydrate   : Output <overnight_brain_diff> Markdown block for Gemini/VS Code/Antigravity (--clip / --out)
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import difflib
import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BRAIN_BASE_URL = os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me").rstrip("/")
if BRAIN_BASE_URL.endswith("/mcp"):
    BRAIN_BASE_URL = BRAIN_BASE_URL[:-4]


# =============================================================================
# ANSI TERMINAL COLOR HELPERS (WINDOWS 11 & LINUX COMPATIBLE)
# =============================================================================
def _enable_windows_ansi() -> bool:
    if not sys.stdout.isatty():
        return False
    if os.environ.get("NO_COLOR"):
        return False
    if platform.system() == "Windows":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_ulong()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:
            pass
    return True


USE_COLOR = _enable_windows_ansi()


class C:
    RESET = "\033[0m" if USE_COLOR else ""
    BOLD = "\033[1m" if USE_COLOR else ""
    DIM = "\033[2m" if USE_COLOR else ""
    RED = "\033[31m" if USE_COLOR else ""
    GREEN = "\033[32m" if USE_COLOR else ""
    YELLOW = "\033[33m" if USE_COLOR else ""
    BLUE = "\033[34m" if USE_COLOR else ""
    MAGENTA = "\033[35m" if USE_COLOR else ""
    CYAN = "\033[36m" if USE_COLOR else ""


# =============================================================================
# CREDENTIAL DISCOVERY (ENV -> .dev.vars -> RPi5 /etc/gemini-brain/watcher.env)
# =============================================================================
def load_bearer_token() -> str:
    token = os.environ.get("MCP_BEARER_TOKEN", "").strip()
    if token:
        return token

    script_dir = Path(__file__).resolve().parent
    candidate_files = [
        script_dir / ".dev.vars",
        Path.cwd() / ".dev.vars",
        script_dir.parent / ".dev.vars",
        Path("/etc/gemini-brain/watcher.env"),
        Path.home() / ".config" / "gemini-brain" / "watcher.env",
        Path.home() / ".gemini-brain.env",
    ]

    for env_file in candidate_files:
        try:
            if env_file.is_file():
                for raw_line in env_file.read_text(encoding="utf-8").splitlines():
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == "MCP_BEARER_TOKEN":
                        val = v.strip().strip('"').strip("'")
                        if val and val != "REPLACE_WITH_MCP_BEARER_TOKEN":
                            return val
        except OSError:
            continue
    return ""


# =============================================================================
# HTTP & MCP JSON-RPC CLIENT
# =============================================================================
def parse_mcp_body(raw_body: str) -> Dict[str, Any]:
    raw_body = raw_body.strip()
    if not raw_body:
        return {}
    try:
        return json.loads(raw_body)
    except json.JSONDecodeError:
        for line in reversed(raw_body.splitlines()):
            if line.startswith("data:"):
                payload = line[len("data:") :].strip()
                if payload:
                    try:
                        return json.loads(payload)
                    except json.JSONDecodeError:
                        continue
        return {"raw": raw_body}


def api_request(
    method: str,
    path: str,
    token: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: int = 35,
) -> Tuple[int, Dict[str, Any], float]:
    url = f"{BRAIN_BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": f"BrainMonitor-CLI/1.2 ({platform.system()})",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, parse_mcp_body(body), elapsed_ms
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        err_body = exc.read().decode("utf-8", errors="replace")
        return exc.code, parse_mcp_body(err_body) or {"error": err_body}, elapsed_ms
    except urllib.error.URLError as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return 0, {"error": str(exc.reason)}, elapsed_ms


def mcp_call_tool(
    tool_name: str, arguments: Dict[str, Any], token: str
) -> Tuple[int, Dict[str, Any], float]:
    rpc_payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }
    return api_request("POST", "/mcp", token, rpc_payload)


def fmt_ts(unix_sec: Optional[int]) -> str:
    if not unix_sec:
        return "unknown"
    return dt.datetime.fromtimestamp(int(unix_sec), tz=dt.timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )


def op_badge(op: str, rolled_back: int = 0) -> str:
    op_u = (op or "UNKNOWN").upper()
    color = C.CYAN
    if op_u == "INSERT":
        color = C.GREEN
    elif op_u == "UPDATE":
        color = C.YELLOW
    elif op_u == "CONSOLIDATE":
        color = C.MAGENTA
    elif op_u in ("ROLLBACK", "DELETE"):
        color = C.RED
    rb = f" {C.RED}[ROLLED BACK]{C.RESET}" if rolled_back else ""
    return f"{color}{C.BOLD}{op_u}{C.RESET}{rb}"


# =============================================================================
# CLIPBOARD HELPER (WINDOWS, LINUX DESKTOP, AND HEADLESS RPI5 SSH VIA OSC52)
# =============================================================================
def copy_to_clipboard(text: str) -> str:
    system = platform.system()
    if system == "Windows":
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
                input=text.encode("utf-8"),
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return "Windows clipboard (Set-Clipboard)"
        except Exception:
            try:
                subprocess.run(
                    ["clip"],
                    input=text.encode("utf-16le"),
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return "Windows clipboard (clip.exe)"
            except Exception:
                pass

    for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        try:
            subprocess.run(
                cmd,
                input=text.encode("utf-8"),
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return f"Linux clipboard ({cmd[0]})"
        except Exception:
            continue

    # Fallback: emit OSC 52 escape sequence (works over SSH from Windows Terminal / VS Code / WezTerm)
    b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    sys.stderr.write(f"\033]52;c;{b64}\a")
    sys.stderr.flush()
    return "OSC 52 terminal clipboard (SSH-compatible)"


# =============================================================================
# SUBCOMMAND 1: SUMMARY (OVERNIGHT DASHBOARD)
# =============================================================================
def cmd_summary(args: argparse.Namespace, token: str) -> int:
    payload = {
        "hours": args.hours,
        "clientId": args.client,
        "namespace": args.namespace,
        "operation": args.operation,
        "limit": args.limit,
    }
    status, data, latency = api_request("POST", "/audit/diff", token, payload)
    if status != 200:
        print(f"{C.RED}Error (HTTP {status}): {json.dumps(data)}{C.RESET}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    summary = data.get("summary", {})
    mutations = data.get("mutations", [])
    decisions = data.get("decisions", [])
    consolidations = data.get("consolidations", [])

    print(f"{C.BOLD}{'=' * 82}{C.RESET}")
    print(
        f" {C.BOLD}{C.CYAN}GEMINI BRAIN — OVERNIGHT MONITOR & AUDIT{C.RESET} "
        f"(Window: Last {data.get('windowHours', args.hours)}h | {latency:.0f} ms)"
    )
    print(f" Endpoint : {BRAIN_BASE_URL} | Since: {data.get('sinceIso', '')}")
    print(f"{C.BOLD}{'=' * 82}{C.RESET}")

    by_op = summary.get("byOperation", {})
    op_str = ", ".join(f"{k}: {v}" for k, v in by_op.items()) or "none"
    by_client = summary.get("byClient", {})
    client_str = ", ".join(f"{k} ({v})" for k, v in by_client.items()) or "none"
    by_ns = summary.get("byNamespace", {})
    ns_str = ", ".join(f"{k} ({v})" for k, v in by_ns.items()) or "none"

    print(f" {C.BOLD}Total Mutations{C.RESET}  : {summary.get('totalMutations', 0)} ({op_str})")
    print(f" {C.BOLD}By Client ID{C.RESET}     : {client_str}")
    print(f" {C.BOLD}By Namespace{C.RESET}     : {ns_str}")
    print(
        f" {C.BOLD}Episodic Queue{C.RESET}   : {summary.get('episodicEventsLogged', 0)} logged in window | "
        f"{C.YELLOW}{summary.get('episodicPending', 0)} pending{C.RESET} | "
        f"Next 03:00 AM Alarm: {summary.get('nextAlarmIso') or 'unscheduled'}"
    )
    print(f" {C.BOLD}ADRs Added{C.RESET}       : {summary.get('decisionsAdded', 0)}")
    print(f"{'-' * 82}")

    if consolidations:
        print(f"\n{C.BOLD}{C.MAGENTA}Nocturnal Consolidation Runs ({len(consolidations)}):{C.RESET}")
        for c in consolidations[:3]:
            print(
                f"  • [Run #{c.get('run_id')}] {fmt_ts(c.get('created_at'))} | "
                f"{c.get('events_count', 0)} events | {c.get('digest_title')}"
            )

    if decisions:
        print(f"\n{C.BOLD}{C.BLUE}New Architecture Decision Records ({len(decisions)}):{C.RESET}")
        for d in decisions[:5]:
            print(
                f"  • [{d.get('decision_id')}] ({d.get('namespace')}) "
                f"{C.BOLD}{d.get('title')}{C.RESET}: {d.get('decision')}"
            )

    print(f"\n{C.BOLD}Recent Memory Mutations ({len(mutations)}):{C.RESET}")
    if not mutations:
        print(f"  {C.DIM}No memory mutations found in the last {args.hours} hours.{C.RESET}")
    else:
        for m in mutations[: args.limit]:
            mut_id = m.get("mutation_id", 0)
            mut_tag = f"#{mut_id:<4}" if mut_id > 0 else "pre  "
            badge = op_badge(m.get("operation", "INSERT"), m.get("rolled_back", 0))
            title = m.get("new_title") or m.get("old_title") or m.get("memory_id")
            print(
                f"  [{C.BOLD}{mut_tag}{C.RESET}] {badge} | {fmt_ts(m.get('created_at'))} | "
                f"ns:{C.CYAN}{m.get('namespace')}{C.RESET} | client:{C.BLUE}{m.get('client_id')}{C.RESET}"
            )
            print(f"          id: {C.DIM}{m.get('memory_id')}{C.RESET} -> {C.BOLD}{title}{C.RESET}")

    print(f"\n{C.DIM}Quick Commands:{C.RESET}")
    print(f"  • Inspect diffs : python brain_monitor.py diff --hours {args.hours}")
    print(f"  • View logs     : python brain_monitor.py logs --hours 24")
    print(f"  • Rollback fact : python brain_monitor.py rollback <mutation_id_or_memory_id>")
    print(f"  • Hydrate LLM   : python brain_monitor.py hydrate --hours {args.hours} --clip")
    return 0


# =============================================================================
# SUBCOMMAND 2: DIFF (UNIFIED BEFORE/AFTER DIFF VIEWER)
# =============================================================================
def render_unified_diff(
    old_text: Optional[str],
    new_text: Optional[str],
    old_label: str = "before",
    new_label: str = "after",
    max_lines: int = 60,
) -> List[str]:
    old_lines = (old_text or "").splitlines()
    new_lines = (new_text or "").splitlines()
    diff_lines = list(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=old_label,
            tofile=new_label,
            lineterm="",
        )
    )
    rendered: List[str] = []
    for idx, line in enumerate(diff_lines):
        if idx >= max_lines:
            rendered.append(
                f"  {C.DIM}... ({len(diff_lines) - max_lines} more diff lines; pass --full to show all){C.RESET}"
            )
            break
        if line.startswith("---") or line.startswith("+++"):
            rendered.append(f"  {C.BOLD}{line}{C.RESET}")
        elif line.startswith("@@"):
            rendered.append(f"  {C.CYAN}{line}{C.RESET}")
        elif line.startswith("-"):
            rendered.append(f"  {C.RED}{line}{C.RESET}")
        elif line.startswith("+"):
            rendered.append(f"  {C.GREEN}{line}{C.RESET}")
        else:
            rendered.append(f"  {line}")
    return rendered


def cmd_diff(args: argparse.Namespace, token: str) -> int:
    payload = {
        "hours": args.hours,
        "clientId": args.client,
        "namespace": args.namespace,
        "memoryId": args.id,
        "operation": args.operation,
        "limit": args.limit,
    }
    status, data, latency = api_request("POST", "/audit/diff", token, payload)
    if status != 200:
        print(f"{C.RED}Error (HTTP {status}): {json.dumps(data)}{C.RESET}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    mutations = data.get("mutations", [])
    print(f"{C.BOLD}{'=' * 82}{C.RESET}")
    print(
        f" {C.BOLD}{C.CYAN}BEFORE/AFTER FACT DIFFS{C.RESET} "
        f"(Window: Last {data.get('windowHours', args.hours)}h | Found: {len(mutations)} | {latency:.0f} ms)"
    )
    print(f"{C.BOLD}{'=' * 82}{C.RESET}")

    if not mutations:
        print(f"\n{C.DIM}No matching mutations in the last {args.hours} hours.{C.RESET}")
        return 0

    max_diff_lines = 9999 if args.full else 45

    for m in mutations:
        mut_id = m.get("mutation_id", 0)
        mut_label = f"mut #{mut_id}" if mut_id > 0 else "pre-audit"
        op = m.get("operation", "INSERT")
        badge = op_badge(op, m.get("rolled_back", 0))
        ts = fmt_ts(m.get("created_at"))
        mem_id = m.get("memory_id", "")
        ns = m.get("namespace", "global")
        client = m.get("client_id", "mcp-client")
        old_title = m.get("old_title")
        new_title = m.get("new_title")
        old_content = m.get("old_content")
        new_content = m.get("new_content")

        print(
            f"\n[{C.BOLD}{mut_label}{C.RESET}] {badge} | {ts} | "
            f"ns: {C.CYAN}{ns}{C.RESET} | client: {C.BLUE}{client}{C.RESET}"
        )
        print(
            f"Memory ID : {C.BOLD}{mem_id}{C.RESET} "
            f"(type: {m.get('memory_type', 'semantic')} | uri: {m.get('source_uri') or 'n/a'})"
        )

        if old_title and new_title and old_title != new_title:
            print(f"Title Diff: {C.RED}- {old_title}{C.RESET}")
            print(f"            {C.GREEN}+ {new_title}{C.RESET}")
        else:
            print(f"Title     : {C.BOLD}{new_title or old_title or mem_id}{C.RESET}")

        if old_content is not None and new_content is not None:
            diff_out = render_unified_diff(
                old_content,
                new_content,
                old_label=f"a/{mem_id} (before)",
                new_label=f"b/{mem_id} (after)",
                max_lines=max_diff_lines,
            )
            if diff_out:
                print("\n".join(diff_out))
            else:
                print(f"  {C.DIM}(Content text identical; metadata/title updated){C.RESET}")
        elif new_content is not None:
            if args.full:
                diff_out = render_unified_diff(
                    "",
                    new_content,
                    old_label="/dev/null",
                    new_label=f"b/{mem_id} (new)",
                    max_lines=max_diff_lines,
                )
                print("\n".join(diff_out))
            else:
                preview_lines = new_content.splitlines()
                shown = preview_lines[:10]
                for pl in shown:
                    print(f"  {C.GREEN}+ {pl}{C.RESET}")
                if len(preview_lines) > 10:
                    print(
                        f"  {C.DIM}... (+{len(preview_lines) - 10} lines; pass --full for complete text){C.RESET}"
                    )
        elif old_content is not None and new_content is None:
            diff_out = render_unified_diff(
                old_content,
                "",
                old_label=f"a/{mem_id} (deleted)",
                new_label="/dev/null",
                max_lines=max_diff_lines,
            )
            print("\n".join(diff_out))

        print(f"{C.DIM}{'-' * 82}{C.RESET}")

    return 0


# =============================================================================
# SUBCOMMAND 3: LOGS (NOCTURNAL CONSOLIDATION & EPISODIC LOGS)
# =============================================================================
def cmd_logs(args: argparse.Namespace, token: str) -> int:
    if args.consolidate:
        print(
            f"{C.YELLOW}Triggering on-demand nocturnal consolidation pass on {BRAIN_BASE_URL}...{C.RESET}"
        )
        c_status, c_data, c_lat = api_request(
            "POST", "/audit/consolidate", token, {"triggerSource": "manual_cli"}
        )
        if c_status != 200:
            print(
                f"{C.RED}Consolidation failed (HTTP {c_status}): {json.dumps(c_data)}{C.RESET}",
                file=sys.stderr,
            )
            return 1
        count = c_data.get("consolidatedCount", 0)
        if count > 0:
            print(
                f"{C.GREEN}✓ Consolidated {count} episodic event(s) in {c_lat:.0f} ms "
                f"-> Run #{c_data.get('runId')} ({c_data.get('digestMemoryId')}){C.RESET}\n"
            )
        else:
            print(
                f"{C.CYAN}ℹ No unconsolidated episodic events pending (0 events processed).{C.RESET}\n"
            )

    payload = {
        "hours": args.hours,
        "clientId": args.client,
        "pendingOnly": args.pending,
        "limit": args.limit,
    }
    status, data, latency = api_request("POST", "/audit/logs", token, payload)
    if status != 200:
        print(f"{C.RED}Error (HTTP {status}): {json.dumps(data)}{C.RESET}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    stats = data.get("stats", {})
    runs = data.get("runs", [])
    logs = data.get("episodicLogs", [])

    print(f"{C.BOLD}{'=' * 82}{C.RESET}")
    print(
        f" {C.BOLD}{C.MAGENTA}NOCTURNAL CONSOLIDATION & EPISODIC SESSION LOGS{C.RESET} "
        f"(Last {data.get('windowHours', args.hours)}h | {latency:.0f} ms)"
    )
    print(
        f" Active Memories: {stats.get('activeMemories', 0)} | "
        f"KG Entities: {stats.get('activeEntities', 0)} | "
        f"KG Edges: {stats.get('activeEdges', 0)}"
    )
    print(
        f" Pending Episodic Events: {C.YELLOW}{stats.get('pendingEpisodicLogs', 0)}{C.RESET} | "
        f"Next 03:00 AM Alarm: {stats.get('nextAlarmIso') or 'unscheduled'}"
    )
    print(f"{C.BOLD}{'=' * 82}{C.RESET}")

    print(f"\n{C.BOLD}{C.MAGENTA}1. Consolidated Sleep-Cycle Digests ({len(runs)}):{C.RESET}")
    if not runs:
        print(f"  {C.DIM}No consolidation digests recorded in the last {args.hours} hours.{C.RESET}")
    else:
        for r in runs:
            run_id = r.get("run_id", 0)
            run_tag = f"Run #{run_id}" if run_id > 0 else "Summary"
            print(
                f"\n  [{C.BOLD}{run_tag}{C.RESET}] {fmt_ts(r.get('created_at'))} | "
                f"events: {r.get('events_count', 0)} | trigger: {r.get('trigger_source')} | "
                f"mem_id: {r.get('digest_memory_id')}"
            )
            print(f"  {C.BOLD}{r.get('digest_title')}{C.RESET}")
            for line in (r.get("digest_content") or "").splitlines():
                print(f"    {line}")

    print(f"\n{C.BOLD}{C.CYAN}2. Raw Episodic Session Events ({len(logs)}):{C.RESET}")
    if not logs:
        print(f"  {C.DIM}No episodic events matching filter in the last {args.hours} hours.{C.RESET}")
    else:
        for lg in logs:
            is_cons = bool(lg.get("consolidated"))
            state_badge = (
                f"{C.GREEN}[CONSOLIDATED]{C.RESET}"
                if is_cons
                else f"{C.YELLOW}[PENDING 03:00]{C.RESET}"
            )
            print(
                f"  [log #{lg.get('log_id')}] {state_badge} {fmt_ts(lg.get('created_at'))} | "
                f"client: {C.BLUE}{lg.get('client_id')}{C.RESET} | "
                f"session: {lg.get('session_id')} | type: {C.BOLD}{lg.get('event_type')}{C.RESET}"
            )
            payload_text = (lg.get("payload") or "").strip()
            for pl in payload_text.splitlines()[:6]:
                print(f"    {pl}")

    return 0


# =============================================================================
# SUBCOMMAND 4: ROLLBACK (ATOMIC MUTATION REVERSAL + VECTORIZE SYNC)
# =============================================================================
def cmd_rollback(args: argparse.Namespace, token: str) -> int:
    target = args.target.strip().lstrip("#")
    payload: Dict[str, Any] = {"clientId": args.client or f"cli-{platform.node()}"}
    if target.isdigit():
        payload["mutationId"] = int(target)
    else:
        payload["memoryId"] = target

    status, data, latency = api_request("POST", "/audit/rollback", token, payload)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0 if status == 200 and data.get("ok") else 1

    if status != 200 or not data.get("ok"):
        print(
            f"{C.RED}✗ Rollback failed (HTTP {status}): {data.get('error') or json.dumps(data)}{C.RESET}",
            file=sys.stderr,
        )
        return 1

    print(f"{C.GREEN}{C.BOLD}✓ Atomic Rollback Complete ({latency:.0f} ms){C.RESET}")
    print(f"  Action            : {C.BOLD}{data.get('action')}{C.RESET}")
    print(f"  Reverted Mutation : #{data.get('rolledBackMutationId')}")
    print(f"  Rollback Audit ID : #{data.get('rollbackAuditId')}")
    print(f"  Memory ID         : {data.get('memoryId')} (namespace: {data.get('namespace')})")
    print(f"  Title             : {data.get('title')}")
    print(f"  Vectorize Synced  : {'YES' if data.get('vectorSynced') else 'NO'}")
    return 0


# =============================================================================
# SUBCOMMAND 5: REINDEX (SQLITE FTS5 REBUILD + VECTORIZE 1024-DIM RE-EMBEDDING)
# =============================================================================
def cmd_reindex(args: argparse.Namespace, token: str) -> int:
    payload: Dict[str, Any] = {
        "hours": args.hours,
        "namespace": args.namespace,
        "rebuildFts": not args.no_fts,
        "limit": args.limit,
    }
    if args.id:
        payload["memoryIds"] = args.id

    print(
        f"{C.CYAN}Running FTS5 rebuild & 1024-dim bge-m3 Vectorize re-indexing on {BRAIN_BASE_URL}...{C.RESET}"
    )
    status, data, latency = api_request("POST", "/audit/reindex", token, payload, timeout=60)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0 if status == 200 else 1

    if status != 200 or not data.get("ok"):
        print(
            f"{C.RED}✗ Re-index failed (HTTP {status}): {json.dumps(data)}{C.RESET}",
            file=sys.stderr,
        )
        return 1

    print(f"{C.GREEN}{C.BOLD}✓ Re-Index Complete ({latency:.0f} ms){C.RESET}")
    print(f"  SQLite FTS5 Rebuilt : {'YES' if data.get('ftsRebuilt') else 'SKIPPED'}")
    print(f"  Vectors Re-Embedded : {data.get('reindexedVectors', 0)} (1024-dim @cf/baai/bge-m3)")
    mem_ids = data.get("memoryIds", [])
    if mem_ids:
        print(f"  Memory IDs ({len(mem_ids)})     : {', '.join(mem_ids[:10])}")
        if len(mem_ids) > 10:
            print(f"                        ... and {len(mem_ids) - 10} more")
    return 0


# =============================================================================
# SUBCOMMAND 6: HYDRATE (MORNING SESSION HYDRATION VIA MCP get_overnight_diff)
# =============================================================================
def cmd_hydrate(args: argparse.Namespace, token: str) -> int:
    mcp_args: Dict[str, Any] = {
        "hours": args.hours,
        "format": "json" if args.json else "markdown",
    }
    if args.client:
        mcp_args["clientId"] = args.client
    if args.namespace:
        mcp_args["namespace"] = args.namespace
    if args.operation and args.operation != "ALL":
        mcp_args["operation"] = args.operation

    status, body, latency = mcp_call_tool("get_overnight_diff", mcp_args, token)
    if status != 200 or "result" not in body:
        print(
            f"{C.RED}✗ MCP get_overnight_diff failed (HTTP {status}): {json.dumps(body)}{C.RESET}",
            file=sys.stderr,
        )
        return 1

    content_items = body.get("result", {}).get("content", [])
    hydration_text = "\n".join(
        item.get("text", "") for item in content_items if item.get("type") == "text"
    ).strip()

    print(hydration_text)

    if args.out:
        out_path = Path(args.out).expanduser().resolve()
        out_path.write_text(hydration_text + "\n", encoding="utf-8")
        print(
            f"\n{C.GREEN}✓ Wrote morning hydration context to: {out_path} ({latency:.0f} ms){C.RESET}",
            file=sys.stderr,
        )

    if args.clip:
        target_used = copy_to_clipboard(hydration_text)
        print(
            f"\n{C.GREEN}✓ Copied <overnight_brain_diff> to {target_used} ({latency:.0f} ms){C.RESET}",
            file=sys.stderr,
        )

    return 0


# =============================================================================
# CLI ARGUMENT PARSER
# =============================================================================
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="brain_monitor.py",
        description=(
            "Terminal Monitoring, Unified Diff, Rollback, Re-Index & Morning Session Hydration CLI "
            "for brain.tsimon.me (Windows 11 & Debian 13 Raspberry Pi 5)."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON response for scripting",
    )

    sub = parser.add_subparsers(dest="subcommand")

    # 1. summary
    p_sum = sub.add_parser(
        "summary",
        help="Overnight dashboard: mutation counts, active ADRs, and consolidation status",
    )
    p_sum.add_argument("--hours", type=float, default=12.0, help="Lookback window in hours (default: 12)")
    p_sum.add_argument("--client", type=str, default="", help="Filter by clientId")
    p_sum.add_argument("--namespace", type=str, default="", help="Filter by namespace")
    p_sum.add_argument(
        "--operation",
        type=str,
        default="ALL",
        choices=["ALL", "INSERT", "UPDATE", "DELETE", "CONSOLIDATE", "ROLLBACK"],
        help="Filter by operation type",
    )
    p_sum.add_argument("--limit", type=int, default=20, help="Max mutations to list (default: 20)")
    p_sum.add_argument("--json", action="store_true", help="Output raw JSON")

    # 2. diff
    p_diff = sub.add_parser(
        "diff",
        help="Inspect colored before/after unified diffs of modified or newly inserted facts",
    )
    p_diff.add_argument("--hours", type=float, default=12.0, help="Lookback window in hours (default: 12)")
    p_diff.add_argument("--id", type=str, default="", help="Filter to a specific memory_id")
    p_diff.add_argument("--client", type=str, default="", help="Filter by clientId")
    p_diff.add_argument("--namespace", type=str, default="", help="Filter by namespace")
    p_diff.add_argument(
        "--operation",
        type=str,
        default="ALL",
        choices=["ALL", "INSERT", "UPDATE", "DELETE", "CONSOLIDATE", "ROLLBACK"],
        help="Filter by operation type",
    )
    p_diff.add_argument("--limit", type=int, default=25, help="Max diffs to display (default: 25)")
    p_diff.add_argument("--full", action="store_true", help="Show full content without line truncation")
    p_diff.add_argument("--json", action="store_true", help="Output raw JSON")

    # 3. logs
    p_logs = sub.add_parser(
        "logs",
        help="View 03:00 AM nocturnal consolidation digests and raw episodic session logs",
    )
    p_logs.add_argument("--hours", type=float, default=24.0, help="Lookback window in hours (default: 24)")
    p_logs.add_argument("--client", type=str, default="", help="Filter episodic logs by clientId")
    p_logs.add_argument("--pending", action="store_true", help="Show only unconsolidated pending logs")
    p_logs.add_argument(
        "--consolidate",
        "--run-now",
        dest="consolidate",
        action="store_true",
        help="Force an immediate nocturnal consolidation pass before viewing logs",
    )
    p_logs.add_argument("--limit", type=int, default=40, help="Max episodic logs to list (default: 40)")
    p_logs.add_argument("--json", action="store_true", help="Output raw JSON")

    # 4. rollback
    p_rb = sub.add_parser(
        "rollback",
        help="Atomically roll back a mutation (by mutation_id or memory_id) and re-sync Vectorize",
    )
    p_rb.add_argument(
        "target",
        type=str,
        help="Mutation ID (e.g., 42) or Memory ID (e.g., e2e-federation-verification) to revert",
    )
    p_rb.add_argument("--client", type=str, default="", help="Optional client identifier for audit log")
    p_rb.add_argument("--json", action="store_true", help="Output raw JSON")

    # 5. reindex
    p_re = sub.add_parser(
        "reindex",
        help="Rebuild SQLite FTS5 BM25 index and re-embed 1024-dim vectors in Cloudflare Vectorize",
    )
    p_re.add_argument("--hours", type=float, default=24.0, help="Re-embed memories modified in last N hours")
    p_re.add_argument("--id", nargs="*", help="Specific memory ID(s) to re-embed")
    p_re.add_argument("--namespace", type=str, default="", help="Optional namespace filter")
    p_re.add_argument("--no-fts", action="store_true", help="Skip SQLite FTS5 rebuild")
    p_re.add_argument("--limit", type=int, default=30, help="Max memories to re-embed in batch (default: 30)")
    p_re.add_argument("--json", action="store_true", help="Output raw JSON")

    # 6. hydrate
    p_hy = sub.add_parser(
        "hydrate",
        help="Pull <overnight_brain_diff> via MCP get_overnight_diff to hydrate Gemini/VS Code/Antigravity",
    )
    p_hy.add_argument("--hours", type=float, default=12.0, help="Lookback window in hours (default: 12)")
    p_hy.add_argument("--client", type=str, default="", help="Filter by clientId")
    p_hy.add_argument("--namespace", type=str, default="", help="Filter by namespace")
    p_hy.add_argument(
        "--operation",
        type=str,
        default="ALL",
        choices=["ALL", "INSERT", "UPDATE", "DELETE", "CONSOLIDATE", "ROLLBACK"],
        help="Filter by operation type",
    )
    p_hy.add_argument("--clip", action="store_true", help="Copy hydration block to clipboard (Win11/Linux/SSH)")
    p_hy.add_argument("--out", type=str, default="", help="Write hydration Markdown to file path")
    p_hy.add_argument("--json", action="store_true", help="Output JSON format from MCP tool")

    return parser


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args()

    token = load_bearer_token()
    if not token:
        print(
            f"{C.RED}Error: MCP_BEARER_TOKEN not found in environment, .dev.vars, or /etc/gemini-brain/watcher.env{C.RESET}",
            file=sys.stderr,
        )
        sys.exit(1)

    subcmd = args.subcommand or "summary"
    if subcmd == "summary" and not hasattr(args, "hours"):
        args.hours = 12.0
        args.client = ""
        args.namespace = ""
        args.operation = "ALL"
        args.limit = 20

    dispatch = {
        "summary": cmd_summary,
        "diff": cmd_diff,
        "logs": cmd_logs,
        "rollback": cmd_rollback,
        "reindex": cmd_reindex,
        "hydrate": cmd_hydrate,
    }
    sys.exit(dispatch[subcmd](args, token))


if __name__ == "__main__":
    main()
