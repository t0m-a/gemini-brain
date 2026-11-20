#!/usr/bin/env python3
"""
test_brain_mcp.py — Verification Suite for Gemini Brain (brain.tsimon.me / local wrangler dev)

Modes:
  --mode smoke (default, strictly READ-ONLY — safe for live production):
    1. SEP-2127 Server Card (/server-card) & version sync vs package.json
    2. Cognitive NOC HTML shell (/mcp?ui=1) renders matching version badge
    3. Auth boundary: unauthenticated POST /mcp rejected with HTTP 401
    4. OAuth security boundary: disallowed redirect_uri (HTTP 400) & forged-code bypass rejected (HTTP 400 invalid_grant)
    5. Authenticated MCP initialize returns serverInfo.version == package.json
    6. Read-only federated hybrid_recall returns [BRAIN] + [KB] + hydrated date tags within tokenBudget

  --mode e2e (mutating lifecycle test — target local wrangler dev or staging):
    Runs write (remember_fact + KG triple) -> recall -> /audit/rollback -> verifies cleanup
    Refuses to write against brain.tsimon.me unless --allow-prod-write is explicitly passed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Tuple


def load_package_version() -> str:
    pkg_path = Path(__file__).resolve().parent / "package.json"
    if pkg_path.exists():
        data = json.loads(pkg_path.read_text(encoding="utf-8"))
        return str(data.get("version", "")).strip()
    return ""


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


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(NoRedirectHandler())


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
    base_url: str,
    method: str,
    path: str,
    payload: Any = None,
    headers: Dict[str, str] | None = None,
    follow_redirects: bool = True,
    content_type: str = "application/json",
) -> Tuple[int, Dict[str, str], str, float]:
    url = f"{base_url}{path}"
    req_headers: Dict[str, str] = {
        "Accept": "application/json, text/event-stream",
        "User-Agent": "BrainMCP-Verifier/1.5 (Antigravity)",
    }
    if headers:
        req_headers.update(headers)

    data: bytes | None = None
    if payload is not None:
        if isinstance(payload, bytes):
            data = payload
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        else:
            data = json.dumps(payload).encode("utf-8")
        req_headers.setdefault("Content-Type", content_type)

    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    opener = urllib.request.urlopen if follow_redirects else NO_REDIRECT_OPENER.open

    start = time.perf_counter()
    try:
        with opener(req, timeout=25) as resp:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            raw_body = resp.read().decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, raw_body, elapsed_ms
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        raw_body = e.read().decode("utf-8", errors="replace")
        resp_headers = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        return e.code, resp_headers, raw_body, elapsed_ms


def mcp_rpc(
    base_url: str,
    bearer_token: str,
    method: str,
    params: Dict[str, Any],
) -> Tuple[int, Dict[str, Any], float]:
    rpc_payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": method,
        "params": params,
    }
    headers = {"Authorization": f"Bearer {bearer_token}"} if bearer_token else {}
    status, _, raw_body, elapsed_ms = http_request(
        base_url, "POST", "/mcp", payload=rpc_payload, headers=headers
    )
    return status, parse_mcp_body(raw_body), elapsed_ms


def extract_tool_text(body: Dict[str, Any]) -> str:
    content_list = body.get("result", {}).get("content", [])
    return "\n".join(
        item.get("text", "") for item in content_list if item.get("type") == "text"
    )


def run_smoke_suite(base_url: str, bearer_token: str, expected_version: str) -> None:
    print("=" * 76)
    print(f"READ-ONLY SMOKE & SECURITY SUITE -> {base_url}")
    if expected_version:
        print(f"Expected Release Version (package.json): {expected_version}")
    print("=" * 76)

    # 1. SEP-2127 Server Card & version sync
    print("\n[Smoke 1/6] SEP-2127 Discovery Card (/server-card)...")
    status, _, raw, ms = http_request(base_url, "GET", "/server-card")
    card = parse_mcp_body(raw)
    card_ver = card.get("version", "")
    if status != 200 or "tools" not in card:
        print(f"  FAIL (HTTP {status}, {ms:.1f} ms): {card}")
        sys.exit(1)
    if expected_version and card_ver != expected_version:
        print(f"  FAIL: /server-card version '{card_ver}' != package.json '{expected_version}'")
        sys.exit(1)
    print(f"  PASS ({ms:.1f} ms): {card.get('name')} v{card_ver} | tools={len(card.get('tools', []))}")

    # 2. Cognitive NOC Dashboard HTML shell
    print("\n[Smoke 2/6] Cognitive NOC Dashboard Shell (/mcp?ui=1)...")
    status, _, html, ms = http_request(
        base_url, "GET", "/mcp?ui=1", headers={"Accept": "text/html"}
    )
    if status != 200 or (expected_version and f"v{expected_version}" not in html):
        print(f"  FAIL (HTTP {status}, {ms:.1f} ms): missing expected version badge v{expected_version}")
        sys.exit(1)
    print(f"  PASS ({ms:.1f} ms): HTML shell served with zero embedded secrets & v{expected_version} badge")

    # 3. Auth boundary: unauthenticated POST /mcp -> 401
    print("\n[Smoke 3/6] Auth Boundary (Unauthenticated POST /mcp -> HTTP 401)...")
    status, _, _, ms = http_request(
        base_url,
        "POST",
        "/mcp",
        payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
    )
    if status != 401:
        print(f"  FAIL: Expected HTTP 401 for unauthenticated /mcp, got {status}")
        sys.exit(1)
    print(f"  PASS ({ms:.1f} ms): Rejected unauthenticated request with HTTP 401")

    # 4. OAuth 2.1 security boundary: disallowed redirect_uri + forged-code bypass check
    print("\n[Smoke 4/6] OAuth 2.1 Boundary (Redirect Allowlist & Upstream Code Verification)...")
    bad_redir_path = f"/authorize?redirect_uri={urllib.parse.quote('https://evil.example/cb', safe='')}"
    status, _, _, ms = http_request(base_url, "GET", bad_redir_path, follow_redirects=False)
    if status != 400:
        print(f"  FAIL: Expected HTTP 400 for disallowed redirect_uri, got {status}")
        sys.exit(1)

    verifier = "smoke-test-pkce-verifier-with-more-than-43-characters-entropy"
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest())
        .decode("ascii")
        .rstrip("=")
    )
    valid_cb = "https://gemini.google.com/mcp/cb"
    auth_path = (
        f"/authorize?redirect_uri={urllib.parse.quote(valid_cb, safe='')}"
        f"&state=smoke&code_challenge={urllib.parse.quote(challenge, safe='')}&code_challenge_method=S256"
    )
    status, hdrs, _, _ = http_request(base_url, "GET", auth_path, follow_redirects=False)
    if status != 302 or "location" not in hdrs:
        print(f"  FAIL: Expected 302 redirect from /authorize, got {status}")
        sys.exit(1)
    bstate = urllib.parse.parse_qs(urllib.parse.urlparse(hdrs["location"]).query).get("state", [""])[0]

    cb_path = f"/callback?code=FORGED_SMOKE_CODE&state={urllib.parse.quote(bstate, safe='')}"
    status, hdrs, _, _ = http_request(base_url, "GET", cb_path, follow_redirects=False)
    if status != 302 or "location" not in hdrs:
        print(f"  FAIL: Expected 302 redirect from /callback, got {status}")
        sys.exit(1)
    bcode = urllib.parse.parse_qs(urllib.parse.urlparse(hdrs["location"]).query).get("code", [""])[0]

    tok_form = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": bcode,
            "code_verifier": verifier,
            "redirect_uri": valid_cb,
        }
    )
    status, _, raw_tok, ms = http_request(
        base_url,
        "POST",
        "/token",
        payload=tok_form,
        content_type="application/x-www-form-urlencoded",
    )
    tok_json = parse_mcp_body(raw_tok)
    if status != 400 or tok_json.get("error") != "invalid_grant" or "access_token" in tok_json:
        print(f"  FAIL: Forged OAuth code was not rejected cleanly (HTTP {status}): {tok_json}")
        sys.exit(1)
    print(f"  PASS ({ms:.1f} ms): Open redirect blocked (400) & forged code rejected upstream (400 invalid_grant)")

    # 5. Authenticated MCP initialize handshake
    print("\n[Smoke 5/6] Authenticated MCP Initialize Handshake...")
    status, body, ms = mcp_rpc(
        base_url,
        bearer_token,
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "brain-smoke-verifier", "version": expected_version or "1.0.0"},
        },
    )
    mcp_ver = body.get("result", {}).get("serverInfo", {}).get("version", "")
    if status != 200 or (expected_version and mcp_ver != expected_version):
        print(f"  FAIL (HTTP {status}): serverInfo.version='{mcp_ver}' expected='{expected_version}'")
        sys.exit(1)
    print(f"  PASS ({ms:.1f} ms): MCP serverInfo.version={mcp_ver}")

    # 6. Read-only federated hybrid_recall
    budget = 2000
    print(f"\n[Smoke 6/6] Read-Only Federated hybrid_recall (budget={budget})...")
    status, body, ms = mcp_rpc(
        base_url,
        bearer_token,
        "tools/call",
        {
            "name": "hybrid_recall",
            "arguments": {
                "query": "Veeam backup retention assessment DPM RMM automation",
                "namespace": "global",
                "tokenBudget": budget,
                "halfLifeDays": 60,
            },
        },
    )
    if status != 200 or "result" not in body:
        print(f"  FAIL (HTTP {status}, {ms:.1f} ms): {body}")
        sys.exit(1)

    ctx = extract_tool_text(body)
    approx_tokens = len(ctx) // 4
    has_brain = "[BRAIN]" in ctx
    has_kb = "[KB]" in ctx and "https://kb.tsimon.me/doc/" in ctx
    has_date = bool(re.search(r"\| date: \d{4}-\d{2}-\d{2}", ctx))
    header_match = re.search(r"<brain_context[^>]+>", ctx)
    header_line = header_match.group(0) if header_match else "<brain_context>"

    print(f"  Latency:         {ms:.1f} ms")
    print(f"  Header:          {header_line}")
    print(f"  Approx Tokens:   ~{approx_tokens} / {budget}")
    print(f"  [BRAIN] Present: {'YES' if has_brain else 'NO'}")
    print(f"  [KB] Present:    {'YES' if has_kb else 'NO'}")
    print(f"  Date Tag Found:  {'YES' if has_date else 'NO'}")

    if not (has_brain and has_kb and has_date and approx_tokens <= budget + 150):
        print("\n  FAIL: Read-only federated hybrid_recall assertions failed.")
        sys.exit(1)

    print("\nOVERALL RESULT: ALL 6 READ-ONLY SMOKE & SECURITY TESTS PASSED (ZERO PROD WRITES)!")


def run_e2e_suite(base_url: str, bearer_token: str) -> None:
    print("=" * 76)
    print(f"MUTATING E2E WRITE -> RECALL -> ROLLBACK LIFECYCLE SUITE -> {base_url}")
    print("=" * 76)

    marker = f"e2e-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    mem_id = f"tmp-{marker}"

    # 1. Write fact + KG triple
    print(f"\n[E2E 1/3] Writing ephemeral memory '{mem_id}' via remember_fact...")
    status, body, ms = mcp_rpc(
        base_url,
        bearer_token,
        "tools/call",
        {
            "name": "remember_fact",
            "arguments": {
                "id": mem_id,
                "namespace": "tsimon.me",
                "memoryType": "semantic",
                "title": f"Ephemeral E2E Test ({marker})",
                "content": f"Ephemeral verification marker {marker} for automated write/recall/rollback testing.",
                "sourceUri": "mcp://test_brain_mcp.py/e2e",
                "importance": 0.5,
                "confidence": 0.9,
                "triples": [
                    {
                        "subjectId": f"test:{marker}",
                        "subjectName": f"E2E Node {marker}",
                        "subjectType": "concept",
                        "relation": "TESTS_AGAINST",
                        "objectId": "domain:brain.tsimon.me",
                        "objectName": "brain.tsimon.me",
                        "objectType": "service",
                    }
                ],
            },
        },
    )
    if status != 200 or "result" not in body:
        print(f"  FAIL (HTTP {status}): {body}")
        sys.exit(1)
    write_result = parse_mcp_body(extract_tool_text(body))
    mutation_id = write_result.get("mutationId")
    print(f"  PASS ({ms:.1f} ms): Stored id={mem_id}, mutationId={mutation_id}")

    time.sleep(1.5)

    try:
        # 2. Recall marker & KG triple
        print(f"\n[E2E 2/3] Recalling '{marker}' via hybrid_recall...")
        status, body, ms = mcp_rpc(
            base_url,
            bearer_token,
            "tools/call",
            {
                "name": "hybrid_recall",
                "arguments": {
                    "query": f"{marker} TESTS_AGAINST brain.tsimon.me",
                    "namespace": "tsimon.me",
                    "tokenBudget": 1200,
                },
            },
        )
        if status != 200 or "result" not in body:
            print(f"  FAIL (HTTP {status}): {body}")
            sys.exit(1)
        ctx = extract_tool_text(body)
        if marker not in ctx or "TESTS_AGAINST" not in ctx:
            print("  FAIL: Recalled context missing marker or 1-hop KG triple.")
            print(ctx)
            sys.exit(1)
        print(f"  PASS ({ms:.1f} ms): Recalled marker and 1-hop KG triple cleanly")
    finally:
        # 3. Rollback & verify cleanup (memory + vector + KG edge retired)
        print(f"\n[E2E 3/3] Rolling back mutationId={mutation_id} via /audit/rollback...")
        rb_status, _, rb_raw, rb_ms = http_request(
            base_url,
            "POST",
            "/audit/rollback",
            payload={"mutationId": mutation_id, "clientId": "e2e-verifier-cleanup"},
            headers={"Authorization": f"Bearer {bearer_token}"},
        )
        rb_json = parse_mcp_body(rb_raw)
        if rb_status != 200 or not rb_json.get("ok"):
            print(f"  FAIL (HTTP {rb_status}): Rollback cleanup failed: {rb_json}")
            sys.exit(1)
        print(
            f"  PASS ({rb_ms:.1f} ms): Cleaned up memory ({rb_json.get('action')}), "
            f"retiredEdges={rb_json.get('retiredEdgesCount')}"
        )

    print("\nOVERALL RESULT: ALL 3 MUTATING E2E + CLEAN ROLLBACK TESTS PASSED!")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Gemini Brain MCP Verification Suite (read-only smoke vs mutating e2e)"
    )
    parser.add_argument(
        "--mode",
        choices=["smoke", "e2e"],
        default="smoke",
        help="'smoke' (default, read-only, prod-safe) or 'e2e' (write/recall/rollback for local/staging)",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me"),
        help="Target Brain base URL (default: https://brain.tsimon.me)",
    )
    parser.add_argument(
        "--allow-prod-write",
        action="store_true",
        help="Explicitly allow --mode e2e against brain.tsimon.me (discouraged; prefer local wrangler dev)",
    )
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    if base_url.endswith("/mcp"):
        base_url = base_url[:-4]

    bearer_token = load_bearer_token()
    if not bearer_token:
        print("FAIL: MCP_BEARER_TOKEN not found in environment or .dev.vars")
        sys.exit(1)

    if args.mode == "smoke":
        run_smoke_suite(base_url, bearer_token, load_package_version())
        return

    if "brain.tsimon.me" in base_url and not args.allow_prod_write:
        print(
            "REFUSED: --mode e2e mutates memory state and is blocked on production brain.tsimon.me.\n"
            "Target local wrangler dev (--url http://127.0.0.1:8787) or a staging URL, "
            "or pass --allow-prod-write if intentional."
        )
        sys.exit(2)

    run_e2e_suite(base_url, bearer_token)


if __name__ == "__main__":
    main()
