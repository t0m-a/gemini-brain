#!/usr/bin/env python3
"""
File: C:\\Users\\simon\\Workspaces\\gemini-brain\\brain_dashboard_server.py
Purpose: Local Zero-WAF Proxy & Browser Launcher for the Gemini Brain Cognitive NOC Dashboard.
         Serves the dashboard at http://127.0.0.1:8765/dashboard and proxies /mcp and /audit/*
         to https://brain.tsimon.me using Python urllib (which bypasses browser WAF/Bot Fight Mode 403s).
"""

from __future__ import annotations

import http.server
import json
import os
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

BRAIN_BASE_URL = os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me").rstrip("/")
if BRAIN_BASE_URL.endswith("/mcp"):
    BRAIN_BASE_URL = BRAIN_BASE_URL[:-4]

PORT = int(os.environ.get("BRAIN_DASHBOARD_PORT", "8765"))


def load_default_token() -> str:
    dev_vars = Path(__file__).resolve().parent / ".dev.vars"
    if dev_vars.is_file():
        for raw_line in dev_vars.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if line.startswith("MCP_BEARER_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


DEFAULT_TOKEN = load_default_token()


class BrainDashboardProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write(f"[Brain-NOC-Proxy] {self.address_string()} - {fmt % args}\n")

    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Accept, X-Brain-Noc-Action, X-Brain-Token",
        )

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self) -> None:
        target_path = self.path
        if target_path in ("/", "/dashboard", "/ui") or target_path.startswith("/dashboard?") or target_path.startswith("/mcp"):
            target_url = f"{BRAIN_BASE_URL}/mcp?ui=1"
        else:
            target_url = f"{BRAIN_BASE_URL}{target_path}"

        headers = {
            "Accept": "text/html,application/json",
            "User-Agent": "BrainMonitor-CLI/1.3 (Windows11-LocalProxy)",
        }
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth
        elif DEFAULT_TOKEN:
            headers["Authorization"] = f"Bearer {DEFAULT_TOKEN}"

        req = urllib.request.Request(target_url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type", "text/html; charset=utf-8")
                self.send_response(resp.status)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self._send_cors()
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            err_body = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            self.wfile.write(err_body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"

        target_url = f"{BRAIN_BASE_URL}{self.path}"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "BrainMonitor-CLI/1.3 (Windows11-LocalProxy)",
        }
        for h in ("Authorization", "X-Brain-Noc-Action", "X-Brain-Token"):
            val = self.headers.get(h)
            if val:
                headers[h] = val

        req = urllib.request.Request(target_url, data=raw_body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=35) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            err_body = exc.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "ok": False,
                        "authError": f"Upstream HTTP {exc.code}: {err_body.decode('utf-8', errors='replace')[:240]}",
                    }
                ).encode("utf-8")
            )


def main() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), BrainDashboardProxyHandler)
    url = f"http://127.0.0.1:{PORT}/dashboard"
    print("=" * 78)
    print(f" GEMINI BRAIN COGNITIVE NOC — LOCAL ZERO-WAF SERVER")
    print(f" Local URL   : {url}")
    print(f" Upstream    : {BRAIN_BASE_URL}/mcp")
    print("=" * 78)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down local dashboard proxy.")
        server.server_close()


if __name__ == "__main__":
    main()
