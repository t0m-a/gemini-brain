#!/usr/bin/env python3
"""
File: rpi-sync/brain_watcher.py
Purpose: Raspberry Pi 5 (Debian 13 Trixie) AST, Markdown & Qdrant Federation Daemon
         syncing local repositories, Obsidian vaults, and local Qdrant (knowledge_hub)
         to https://brain.tsimon.me/mcp (BrainMemoryDO).
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

# =============================================================================
# CONFIGURATION BLOCK (ENVIRONMENT VARIABLES)
# =============================================================================
BRAIN_MCP_URL: str = os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me/mcp")
MCP_BEARER_TOKEN: str = os.environ.get("MCP_BEARER_TOKEN", "")
WATCH_DIRS_RAW: str = os.environ.get(
    "WATCH_DIRS",
    "/opt/edge-rag-hub,/home/simon/Workspaces",
)
DEFAULT_NAMESPACE: str = os.environ.get("BRAIN_NAMESPACE", "homelab")
CLIENT_ID: str = os.environ.get("BRAIN_CLIENT_ID", "rpi5-debian13-daemon")
STATE_DB_PATH: Path = Path(
    os.environ.get("BRAIN_STATE_DB", "~/.cache/gemini-brain/sync_state.db")
).expanduser()
DEBOUNCE_SECONDS: float = float(os.environ.get("BRAIN_DEBOUNCE_SEC", "2.5"))
MAX_FILE_BYTES: int = int(os.environ.get("BRAIN_MAX_FILE_BYTES", "250000"))

# Qdrant Federation Configuration (Raspberry Pi 5 Edge RAG Hub -> BrainMemoryDO)
QDRANT_URL: str = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
QDRANT_API_KEY: str = os.environ.get("QDRANT_API_KEY", "")
QDRANT_COLLECTION: str = os.environ.get("QDRANT_COLLECTION", "knowledge_hub")
QDRANT_ENV_FALLBACK: Path = Path(
    os.environ.get("QDRANT_ENV_FILE", "/opt/edge-rag-hub/.env")
)
QDRANT_SYNC_INTERVAL_SEC: float = float(
    os.environ.get("QDRANT_SYNC_INTERVAL_SEC", "300.0")
)

IGNORED_DIRS: set[str] = {
    ".git",
    "node_modules",
    ".wrangler",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".obsidian",
    "qdrant_data",
    "qdrant_config",
    "fastembed_cache",
    "cloudflared_data",
}
SUPPORTED_EXTENSIONS: set[str] = {".py", ".md"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("brain-watcher")


def _load_qdrant_credentials() -> tuple[str, str]:
    """Loads QDRANT_API_KEY and QDRANT_COLLECTION from env or /opt/edge-rag-hub/.env."""
    api_key = QDRANT_API_KEY
    collection = QDRANT_COLLECTION
    if (not api_key or not collection) and QDRANT_ENV_FALLBACK.is_file():
        try:
            for raw_line in QDRANT_ENV_FALLBACK.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k == "QDRANT_API_KEY" and not api_key:
                    api_key = v
                elif k == "QDRANT_COLLECTION" and v:
                    collection = v
        except OSError as exc:
            logger.debug("Could not read %s: %s", QDRANT_ENV_FALLBACK, exc)
    return api_key, collection


# =============================================================================
# DATA STRUCTURES & LOCAL SQLITE STATE CACHE
# =============================================================================
@dataclass(frozen=True)
class SemanticChunk:
    chunk_id: str
    namespace: str
    memory_type: str
    title: str
    content: str
    summary: str
    source_uri: str
    importance: float = 0.75
    triples: list[dict[str, str]] = field(default_factory=list)

    @property
    def content_sha256(self) -> str:
        payload = f"{self.title}\n{self.content}\n{json.dumps(self.triples, sort_keys=True)}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class LocalSyncStateDB:
    """Tracks synced chunk hashes locally so unchanged chunks never re-trigger Vectorize embeddings."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS synced_chunks (
                chunk_id TEXT PRIMARY KEY,
                source_uri TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                synced_at INTEGER NOT NULL
            )
            """
        )
        self.conn.commit()

    def is_unchanged(self, chunk_id: str, content_sha256: str) -> bool:
        cur = self.conn.execute(
            "SELECT content_sha256 FROM synced_chunks WHERE chunk_id = ?",
            (chunk_id,),
        )
        row = cur.fetchone()
        return bool(row and row[0] == content_sha256)

    def mark_synced(self, chunk_id: str, source_uri: str, content_sha256: str) -> None:
        self.conn.execute(
            """
            INSERT INTO synced_chunks (chunk_id, source_uri, content_sha256, synced_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                source_uri = excluded.source_uri,
                content_sha256 = excluded.content_sha256,
                synced_at = excluded.synced_at
            """,
            (chunk_id, source_uri, content_sha256, int(time.time())),
        )
        self.conn.commit()


# =============================================================================
# SEMANTIC CHUNKING ENGINE (PYTHON AST + MARKDOWN HEADER & WIKILINK PARSER)
# =============================================================================
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
MD_HEADER_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-")
    return cleaned or "unnamed"


def make_chunk_id(prefix: str, unique_key: str) -> str:
    digest = hashlib.sha256(unique_key.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def chunk_python_file(file_path: Path, rel_path: str, namespace: str) -> list[SemanticChunk]:
    source = file_path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(source, filename=rel_path)
    except SyntaxError as exc:
        logger.warning("Skipping Python file with syntax error %s: %s", rel_path, exc)
        return []

    chunks: list[SemanticChunk] = []
    file_entity_id = f"file:{slugify(rel_path)}"

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            node_kind = "class" if isinstance(node, ast.ClassDef) else "function"
            segment = ast.get_source_segment(source, node) or ""
            if not segment.strip():
                continue

            docstring = ast.get_docstring(node) or f"Python {node_kind} {node.name} in {rel_path}"
            first_line = docstring.strip().splitlines()[0][:240]
            chunk_id = make_chunk_id("py", f"{namespace}:{rel_path}:{node.name}")
            symbol_entity_id = f"symbol:{slugify(rel_path)}:{slugify(node.name)}"

            triples = [
                {
                    "subjectId": symbol_entity_id,
                    "subjectName": f"{node.name} ({rel_path})",
                    "subjectType": "concept",
                    "relation": "DEFINED_IN",
                    "objectId": file_entity_id,
                    "objectName": rel_path,
                    "objectType": "project",
                }
            ]

            chunks.append(
                SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=namespace,
                    memory_type="procedural",
                    title=f"[Py {node_kind.capitalize()}] {rel_path} :: {node.name}",
                    content=f"```python\n# File: {rel_path}\n{segment.strip()}\n```",
                    summary=first_line,
                    source_uri=f"rpi5://{rel_path}#{node.name}",
                    importance=0.75,
                    triples=triples,
                )
            )

    return chunks


def chunk_markdown_file(file_path: Path, rel_path: str, namespace: str) -> list[SemanticChunk]:
    text = file_path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return []

    matches = list(MD_HEADER_RE.finditer(text))
    sections: list[tuple[str, str]] = []

    if not matches:
        sections.append((file_path.stem, text.strip()))
    else:
        for idx, match in enumerate(matches):
            heading_title = match.group(2).strip()
            start = match.start()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
            section_body = text[start:end].strip()
            if len(section_body) >= 40:
                sections.append((heading_title, section_body))

    chunks: list[SemanticChunk] = []
    doc_entity_id = f"doc:{slugify(file_path.stem)}"

    for heading, body in sections:
        chunk_id = make_chunk_id("md", f"{namespace}:{rel_path}:{heading}")
        wikilinks = sorted(set(WIKILINK_RE.findall(body)))
        triples = [
            {
                "subjectId": doc_entity_id,
                "subjectName": file_path.stem,
                "subjectType": "concept",
                "relation": "LINKS_TO",
                "objectId": f"concept:{slugify(target)}",
                "objectName": target.strip(),
                "objectType": "concept",
            }
            for target in wikilinks[:10]
        ]

        plain_lines = [
            line.strip()
            for line in body.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        summary = (plain_lines[0] if plain_lines else heading)[:240]

        chunks.append(
            SemanticChunk(
                chunk_id=chunk_id,
                namespace=namespace,
                memory_type="semantic",
                title=f"{file_path.stem} — {heading}",
                content=body,
                summary=summary,
                source_uri=f"rpi5://{rel_path}#{slugify(heading)}",
                importance=0.80,
                triples=triples,
            )
        )

    return chunks


# =============================================================================
# STREAMABLE HTTP MCP JSON-RPC CLIENT (WITH EXPONENTIAL BACKOFF)
# =============================================================================
class BrainMcpClient:
    def __init__(self, endpoint: str, token: str) -> None:
        if not token:
            raise ValueError("MCP_BEARER_TOKEN environment variable is required.")
        self.endpoint = endpoint
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self.client = httpx.Client(timeout=30.0, headers=self.headers)
        self._req_id = 1

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self._req_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }

        backoff = 1.5
        for attempt in range(1, 5):
            try:
                resp = self.client.post(self.endpoint, json=payload)
                resp.raise_for_status()
                ctype = resp.headers.get("content-type", "")
                if "text/event-stream" in ctype:
                    for line in resp.text.splitlines():
                        if line.startswith("data: "):
                            return json.loads(line[6:])
                return resp.json()
            except Exception as exc:
                if attempt == 4:
                    raise
                logger.warning(
                    "MCP tool %s attempt %d failed (%s). Retrying in %.1fs...",
                    name,
                    attempt,
                    exc,
                    backoff,
                )
                time.sleep(backoff)
                backoff *= 2.0
        return {}


# =============================================================================
# QDRANT -> BRAINMEMORYDO FEDERATION ENGINE
# =============================================================================
class QdrantBrainFederator:
    """Scrolls points from Raspberry Pi 5 Qdrant and federates them into BrainMemoryDO."""

    def __init__(
        self,
        qdrant_url: str,
        api_key: str,
        collection: str,
        namespace: str,
        state_db: LocalSyncStateDB,
        mcp: BrainMcpClient,
    ) -> None:
        self.qdrant_url = qdrant_url.rstrip("/")
        self.api_key = api_key
        self.collection = collection
        self.namespace = namespace
        self.state_db = state_db
        self.mcp = mcp
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["api-key"] = self.api_key
        self.http = httpx.Client(timeout=20.0, headers=headers)

    def sync_collection(self) -> int:
        if not self.api_key:
            logger.info("QDRANT_API_KEY not configured; skipping Qdrant federation pass.")
            return 0

        scroll_url = f"{self.qdrant_url}/collections/{self.collection}/points/scroll"
        next_offset: str | int | None = None
        synced_count = 0
        scanned_count = 0

        logger.info(
            "Starting Qdrant -> BrainMemoryDO federation scan (%s/%s)...",
            self.qdrant_url,
            self.collection,
        )

        while True:
            req_body: dict[str, Any] = {
                "limit": 100,
                "with_payload": True,
                "with_vector": False,
            }
            if next_offset is not None:
                req_body["offset"] = next_offset

            try:
                resp = self.http.post(scroll_url, json=req_body)
                resp.raise_for_status()
                data = resp.json().get("result", {})
            except Exception as exc:
                logger.warning("Qdrant scroll request failed: %s", exc)
                break

            points = data.get("points", [])
            if not points:
                break

            for pt in points:
                scanned_count += 1
                point_id = str(pt.get("id", ""))
                payload = pt.get("payload") or {}
                content = str(payload.get("content") or "").strip()
                if not point_id or not content:
                    continue

                raw_title = str(payload.get("title") or point_id).strip()
                category = str(payload.get("category") or "General").strip()
                source = str(payload.get("source") or f"qdrant/{point_id}").strip()

                chunk_id = f"qdrant_{point_id}"
                memory_type = "procedural" if "```" in content else "semantic"
                title = f"[Qdrant/{category}] {raw_title}"
                source_uri = f"qdrant://{self.collection}/{source}#{point_id[:8]}"

                plain_lines = [
                    line.strip()
                    for line in content.splitlines()
                    if line.strip() and not line.strip().startswith("#")
                ]
                summary = (plain_lines[0] if plain_lines else raw_title)[:240]

                doc_entity_id = f"doc:{slugify(source)}"
                cat_entity_id = f"category:{slugify(category)}"
                triples: list[dict[str, str]] = [
                    {
                        "subjectId": doc_entity_id,
                        "subjectName": source,
                        "subjectType": "project",
                        "relation": "CATEGORIZED_AS",
                        "objectId": cat_entity_id,
                        "objectName": f"Category: {category}",
                        "objectType": "concept",
                    },
                    {
                        "subjectId": doc_entity_id,
                        "subjectName": source,
                        "subjectType": "project",
                        "relation": "FEDERATED_FROM",
                        "objectId": "service:rpi5-qdrant-knowledge-hub",
                        "objectName": f"RPi5 Qdrant ({self.collection} / rag.tsimon.me)",
                        "objectType": "service",
                    },
                ]

                for target in sorted(set(WIKILINK_RE.findall(content)))[:8]:
                    triples.append(
                        {
                            "subjectId": doc_entity_id,
                            "subjectName": source,
                            "subjectType": "project",
                            "relation": "LINKS_TO",
                            "objectId": f"concept:{slugify(target)}",
                            "objectName": target.strip(),
                            "objectType": "concept",
                        }
                    )

                chunk = SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=self.namespace,
                    memory_type=memory_type,
                    title=title,
                    content=content,
                    summary=summary,
                    source_uri=source_uri,
                    importance=0.82,
                    triples=triples,
                )

                sha = chunk.content_sha256
                if self.state_db.is_unchanged(chunk.chunk_id, sha):
                    continue

                self.mcp.call_tool(
                    "remember_fact",
                    {
                        "id": chunk.chunk_id,
                        "namespace": chunk.namespace,
                        "memoryType": chunk.memory_type,
                        "title": chunk.title,
                        "content": chunk.content,
                        "summary": chunk.summary,
                        "sourceUri": chunk.source_uri,
                        "importance": chunk.importance,
                        "triples": chunk.triples,
                    },
                )
                self.state_db.mark_synced(chunk.chunk_id, chunk.source_uri, sha)
                synced_count += 1
                logger.info(
                    "Federated Qdrant point [%s] %s (%d/%d)",
                    self.collection,
                    title,
                    synced_count,
                    scanned_count,
                )

            next_offset = data.get("next_page_offset")
            if next_offset is None:
                break

        logger.info(
            "Qdrant federation pass complete: scanned=%d, newly_synced=%d",
            scanned_count,
            synced_count,
        )
        return synced_count


# =============================================================================
# WATCHDOG EVENT HANDLER & INITIAL DIRECTORY SWEEP
# =============================================================================
class BrainSyncHandler(FileSystemEventHandler):
    def __init__(
        self,
        root_dir: Path,
        namespace: str,
        state_db: LocalSyncStateDB,
        mcp: BrainMcpClient,
    ) -> None:
        super().__init__()
        self.root_dir = root_dir.resolve()
        self.namespace = namespace
        self.state_db = state_db
        self.mcp = mcp
        self._last_triggered: dict[str, float] = {}

    def _should_process(self, path_str: str) -> Path | None:
        path = Path(path_str)
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return None
        if any(part in IGNORED_DIRS or part.startswith(".env") for part in path.parts):
            return None
        if path.name.endswith(".local.ps1") or "HUMAN_CONTEXT" in path.name.upper():
            return None
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                return None
        except OSError:
            return None

        now = time.monotonic()
        last = self._last_triggered.get(path_str, 0.0)
        if now - last < DEBOUNCE_SECONDS:
            return None
        self._last_triggered[path_str] = now
        return path

    def sync_file(self, file_path: Path) -> int:
        try:
            rel_path = file_path.resolve().relative_to(self.root_dir).as_posix()
        except ValueError:
            rel_path = file_path.name

        if file_path.suffix.lower() == ".py":
            chunks = chunk_python_file(file_path, rel_path, self.namespace)
        else:
            chunks = chunk_markdown_file(file_path, rel_path, self.namespace)

        synced_count = 0
        for chunk in chunks:
            sha = chunk.content_sha256
            if self.state_db.is_unchanged(chunk.chunk_id, sha):
                continue

            self.mcp.call_tool(
                "remember_fact",
                {
                    "id": chunk.chunk_id,
                    "namespace": chunk.namespace,
                    "memoryType": chunk.memory_type,
                    "title": chunk.title,
                    "content": chunk.content,
                    "summary": chunk.summary,
                    "sourceUri": chunk.source_uri,
                    "importance": chunk.importance,
                    "triples": chunk.triples,
                },
            )
            self.state_db.mark_synced(chunk.chunk_id, chunk.source_uri, sha)
            synced_count += 1
            logger.info("Synced chunk [%s] %s", chunk.namespace, chunk.title)

        return synced_count

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            target = self._should_process(str(event.src_path))
            if target:
                self.sync_file(target)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            target = self._should_process(str(event.src_path))
            if target:
                self.sync_file(target)


def main() -> None:
    state_db = LocalSyncStateDB(STATE_DB_PATH)
    mcp = BrainMcpClient(BRAIN_MCP_URL, MCP_BEARER_TOKEN)
    qdrant_key, qdrant_collection = _load_qdrant_credentials()
    federator = QdrantBrainFederator(
        qdrant_url=QDRANT_URL,
        api_key=qdrant_key,
        collection=qdrant_collection,
        namespace=DEFAULT_NAMESPACE,
        state_db=state_db,
        mcp=mcp,
    )

    watch_dirs = [Path(p.strip()).expanduser() for p in WATCH_DIRS_RAW.split(",") if p.strip()]

    observer = Observer()
    total_initial_chunks = 0

    for directory in watch_dirs:
        if not directory.exists():
            logger.warning("Watch directory %s does not exist yet; skipping.", directory)
            continue

        handler = BrainSyncHandler(directory, DEFAULT_NAMESPACE, state_db, mcp)
        logger.info("Performing initial semantic scan of %s...", directory)
        for candidate in sorted(directory.rglob("*")):
            validated = handler._should_process(str(candidate))
            if validated:
                total_initial_chunks += handler.sync_file(validated)

        observer.schedule(handler, str(directory), recursive=True)
        logger.info("Watching %s (namespace=%s)", directory, DEFAULT_NAMESPACE)

    # Federate local Qdrant collection into BrainMemoryDO
    total_qdrant_chunks = federator.sync_collection()
    last_qdrant_sync = time.monotonic()

    if (total_initial_chunks + total_qdrant_chunks) > 0:
        mcp.call_tool(
            "log_episodic_event",
            {
                "sessionId": f"boot-{int(time.time())}",
                "clientId": CLIENT_ID,
                "eventType": "checkpoint",
                "payload": (
                    f"Raspberry Pi 5 daemon synced {total_initial_chunks} filesystem chunks "
                    f"and federated {total_qdrant_chunks} Qdrant ({qdrant_collection}) points."
                ),
            },
        )

    observer.start()
    logger.info("Raspberry Pi 5 Brain Watcher + Qdrant Federator is active. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(5)
            if time.monotonic() - last_qdrant_sync >= QDRANT_SYNC_INTERVAL_SEC:
                federator.sync_collection()
                last_qdrant_sync = time.monotonic()
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
