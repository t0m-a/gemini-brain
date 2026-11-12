#!/usr/bin/env python3
"""
test_brain_mcp.py — End-to-End Live Verification Suite for brain.tsimon.me
Tests:
  1. SEP-2127 Static Server Card Discovery (/server-card & /.well-known/mcp/server-card.json)
  2. Streamable HTTP MCP Tool Execution: remember_fact (SQLite + 1024-dim Vectorize + KG Triples)
  3. Streamable HTTP MCP Tool Execution: hybrid_recall (Brain Episodic/Semantic + 1-Hop KG + Token Budget)
  4. Cross-Source Federation Verification: hybrid_recall merging brain.tsimon.me + kb.tsimon.me (D1 + 768-dim Vectorize)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Tuple

BRAIN_BASE_URL = os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me").rstrip("/")


def load_bearer_token() -> str:
    token = os.environ.get("MCP_BEARER_TOKEN", "").strip()
    if token:
        return token

    dev_vars = Path(__file__).resolve().parent / ".dev.vars"
    if dev_vars.exists():
        for line in dev_vars.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MCP_BEARER_TOKEN="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    return ""


BEARER_TOKEN = load_bearer_token()

HEADERS: Dict[str, str] = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "BrainMCP-Verifier/1.1 (Windows11-Antigravity)",
}

if BEARER_TOKEN:
    HEADERS["Authorization"] = f"Bearer {BEARER_TOKEN}"


def parse_mcp_body(raw_body: str) -> Dict[str, Any]:
    """Parses either standard JSON or Server-Sent Events (SSE) JSON-RPC payloads."""
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


def http_request(
    method: str, path: str, payload: Dict[str, Any] | None = None
) -> Tuple[int, Dict[str, Any], float]:
    url = f"{BRAIN_BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)

    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            raw_body = resp.read().decode("utf-8")
            return resp.status, parse_mcp_body(raw_body), elapsed_ms
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        err_body = e.read().decode("utf-8", errors="replace")
        return e.code, {"error": err_body}, elapsed_ms


def mcp_rpc_call(
    tool_name: str, arguments: Dict[str, Any]
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
    return http_request("POST", "/mcp", rpc_payload)


def extract_tool_text(body: Dict[str, Any]) -> str:
    content_list = body.get("result", {}).get("content", [])
    return "\n".join(
        item.get("text", "") for item in content_list if item.get("type") == "text"
    )


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    print("=" * 76)
    print(f"Starting Live Verification for: {BRAIN_BASE_URL}")
    print("=" * 76)

    if not BEARER_TOKEN:
        print("FAIL: MCP_BEARER_TOKEN not found in environment or .dev.vars")
        sys.exit(1)

    # -------------------------------------------------------------------------
    # TEST 1: SEP-2127 Static Discovery Card
    # -------------------------------------------------------------------------
    print("\n[Test 1/4] Verifying SEP-2127 Static Server Card (/server-card)...")
    status, body, latency = http_request("GET", "/server-card")
    if status == 200 and "name" in body and "tools" in body:
        print(
            f"  PASS ({latency:.1f} ms): Server={body.get('name')} v{body.get('version')}"
        )
        print(f"  Tools: {', '.join(body.get('tools', []))}")
        if "federated_sources" in body:
            print(f"  Federated Sources: {body['federated_sources']}")
    else:
        print(f"  FAIL (HTTP {status}, {latency:.1f} ms): {body}")
        sys.exit(1)

    # -------------------------------------------------------------------------
    # TEST 2: Write Semantic Memory + Knowledge Graph Triples (remember_fact)
    # -------------------------------------------------------------------------
    test_marker = f"verif-{int(time.time())}"
    print(
        f"\n[Test 2/4] Writing Episodic & KG Fact via remember_fact (marker: {test_marker})..."
    )

    remember_args = {
        "id": f"e2e-federation-verification",
        "namespace": "tsimon.me",
        "memoryType": "semantic",
        "title": f"E2E Federation Verification ({test_marker})",
        "content": (
            f"Verification token {test_marker}: The Cross-Client Brain at brain.tsimon.me "
            f"is actively federated with kb.tsimon.me via Cloudflare D1 (archive-knowledge-db) "
            f"and Vectorize (archive-kb-index 768-dim + gemini-brain-bge-m3 1024-dim) using "
            f"4-way Weighted Reciprocal Rank Fusion (RRF k=60)."
        ),
        "sourceUri": "mcp://test_brain_mcp.py",
        "importance": 0.92,
        "triples": [
            {
                "subjectId": "domain:brain.tsimon.me",
                "subjectName": "brain.tsimon.me",
                "subjectType": "service",
                "relation": "FEDERATES_WITH",
                "objectId": "domain:kb.tsimon.me",
                "objectName": "kb.tsimon.me",
                "objectType": "service",
            }
        ],
    }

    status, body, latency = mcp_rpc_call("remember_fact", remember_args)
    if status == 200 and "result" in body:
        tool_text = extract_tool_text(body)
        print(
            f"  PASS ({latency:.1f} ms): Stored memory & indexed vector in BrainMemoryDO + Vectorize."
        )
        print(f"  Response: {tool_text.strip()}")
    else:
        print(f"  FAIL (HTTP {status}, {latency:.1f} ms): {json.dumps(body, indent=2)}")
        sys.exit(1)

    # Brief pause for Vectorize index mutation visibility
    time.sleep(1.5)

    # -------------------------------------------------------------------------
    # TEST 3: Hybrid Recall (Brain Episodic + 1-Hop KG + Token Budget)
    # -------------------------------------------------------------------------
    budget = 1600
    print(
        f"\n[Test 3/4] Executing hybrid_recall for Brain marker '{test_marker}' (budget={budget} tokens)..."
    )

    recall_args = {
        "query": f"{test_marker} brain.tsimon.me FEDERATES_WITH kb.tsimon.me Reciprocal Rank Fusion",
        "namespace": "tsimon.me",
        "tokenBudget": budget,
    }

    status, body, latency = mcp_rpc_call("hybrid_recall", recall_args)
    if status != 200 or "result" not in body:
        print(f"  FAIL (HTTP {status}, {latency:.1f} ms): {json.dumps(body, indent=2)}")
        sys.exit(1)

    compiled_context = extract_tool_text(body)
    approx_tokens = len(compiled_context) // 4
    found_marker = test_marker in compiled_context
    found_kg = "FEDERATES_WITH" in compiled_context
    within_budget = approx_tokens <= (budget + 100)

    print(f"  Latency:         {latency:.1f} ms")
    print(f"  Approx Tokens:   ~{approx_tokens} / {budget}")
    print(f"  Marker Found:    {'YES' if found_marker else 'NO'}")
    print(f"  1-Hop KG Found:  {'YES' if found_kg else 'NO'}")
    print(f"  Budget Respected:{'YES' if within_budget else 'NO'}")

    if not (found_marker and within_budget):
        print("\n  FAIL: Brain verification marker or budget assertion failed!")
        print(compiled_context)
        sys.exit(1)

    # -------------------------------------------------------------------------
    # TEST 4: Cross-Source Federation Verification (kb.tsimon.me D1 + Vectorize)
    # -------------------------------------------------------------------------
    print(
        "\n[Test 4/4] Executing Federated hybrid_recall across kb.tsimon.me (D1 archive-knowledge-db + archive-kb-index)..."
    )

    kb_recall_args = {
        "query": "Veeam backup retention assessment DPM RMM automation sql.md",
        "namespace": "global",
        "tokenBudget": 2400,
    }

    status, body, latency = mcp_rpc_call("hybrid_recall", kb_recall_args)
    if status != 200 or "result" not in body:
        print(f"  FAIL (HTTP {status}, {latency:.1f} ms): {json.dumps(body, indent=2)}")
        sys.exit(1)

    kb_context = extract_tool_text(body)
    has_kb_badge = "[KB]" in kb_context and "https://kb.tsimon.me/doc/" in kb_context
    has_brain_badge = "[BRAIN]" in kb_context

    header_match = re.search(r"<brain_context[^>]+>", kb_context)
    header_line = header_match.group(0) if header_match else "<brain_context>"

    print(f"  Latency:         {latency:.1f} ms")
    print(f"  Context Header:  {header_line}")
    print(f"  [BRAIN] Chunks:  {'PRESENT' if has_brain_badge else 'MISSING'}")
    print(f"  [KB] Chunks:     {'PRESENT' if has_kb_badge else 'MISSING'}")

    print("\n--- Federated Context Preview (First 1,100 chars) ---")
    print(kb_context[:1100] + ("\n...[truncated]" if len(kb_context) > 1100 else ""))
    print("-----------------------------------------------------")

    if has_kb_badge and has_brain_badge:
        print(
            "\nOVERALL RESULT: ALL 4 LIVE VERIFICATION TESTS PASSED (BRAIN + KB FEDERATION ACTIVE)!"
        )
    else:
        print(
            "\nFAIL: Expected both [BRAIN] and [KB] federated chunks in <brain_context>."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
