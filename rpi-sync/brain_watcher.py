#!/usr/bin/env python3
"""
File: C:\\Users\\simon\\Workspaces\\gemini-brain\\rpi-sync\\brain_watcher.py
Purpose: Raspberry Pi 5 (Debian 13) Semantic AST & Markdown Knowledge Brain Sync Daemon.
         Watches configured local repositories and Obsidian vaults, parses Python AST
         definitions and Markdown header sections (extracting YAML frontmatter tags and
         [[Wikilinks]] as Knowledge Graph triples), caches file mtime + chunk SHA-256
         hashes in local SQLite (~/.cache/gemini-brain-sync.db), and pushes modified
         chunks to https://brain.tsimon.me/mcp over Streamable HTTP JSON-RPC 2.0.
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import re
import signal
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

# ============================================================================
# 1. Configuration via Environment Variables
# ============================================================================
BRAIN_MCP_URL = os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me/mcp")
MCP_BEARER_TOKEN = os.environ["MCP_BEARER_TOKEN"]
WATCH_DIRS = [
    Path(p.strip()).expanduser().resolve()
    for p in os.environ.get(
        "WATCH_DIRS", "/opt/edge-rag-hub,/home/thomas/obsidian-vault"
    ).split(",")
    if p.strip()
]
DEFAULT_NAMESPACE = os.environ.get("BRAIN_NAMESPACE", "homelab")
STATE_DB_PATH = Path(
    os.environ.get("BRAIN_STATE_DB", "~/.cache/gemini-brain-sync.db")
).expanduser()

IGNORED_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".obsidian",
    ".trash",
    "dist",
    "build",
}
SUPPORTED_EXTENSIONS = {".py", ".md"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
)
logger = logging.getLogger("brain_watcher")


# ============================================================================
# 2. Data Structures & Local SQLite Deduplication Cache
# ============================================================================
@dataclass
class GraphTriplePayload:
    subjectId: str
    subjectName: str
    relation: str
    objectId: str
    objectName: str
    subjectType: str = "concept"
    objectType: str = "concept"

    def to_dict(self) -> dict[str, str]:
        return {
            "subjectId": self.subjectId,
            "subjectName": self.subjectName,
            "subjectType": self.subjectType,
            "relation": self.relation,
            "objectId": self.objectId,
            "objectName": self.objectName,
            "objectType": self.objectType,
        }


@dataclass
class SemanticChunk:
    chunk_id: str
    namespace: str
    memory_type: str  # 'procedural' | 'semantic'
    title: str
    content: str
    summary: str
    source_uri: str
    importance: float = 0.7
    triples: list[GraphTriplePayload] = field(default_factory=list)

    @property
    def content_sha256(self) -> str:
        payload = json.dumps(
            {
                "title": self.title,
                "content": self.content,
                "summary": self.summary,
                "namespace": self.namespace,
                "triples": [t.to_dict() for t in self.triples],
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class LocalSyncStateCache:
    """SQLite state store preventing redundant Vectorize embedding calls for unchanged chunks."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._init_schema()

    def _init_schema(self) -> None:
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS file_state (
                    file_path TEXT PRIMARY KEY,
                    mtime_ns INTEGER NOT NULL,
                    file_sha256 TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chunk_state (
                    chunk_id TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    synced_at INTEGER NOT NULL
                )
                """
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunk_file ON chunk_state(file_path)"
            )

    def is_file_unchanged(self, file_path: Path, mtime_ns: int, file_sha256: str) -> bool:
        cur = self.conn.execute(
            "SELECT mtime_ns, file_sha256 FROM file_state WHERE file_path = ?",
            (str(file_path),),
        )
        row = cur.fetchone()
        if not row:
            return False
        return row[0] == mtime_ns and row[1] == file_sha256

    def is_chunk_unchanged(self, chunk_id: str, content_sha256: str) -> bool:
        cur = self.conn.execute(
            "SELECT content_sha256 FROM chunk_state WHERE chunk_id = ?",
            (chunk_id,),
        )
        row = cur.fetchone()
        return bool(row and row[0] == content_sha256)

    def record_chunk_sync(self, chunk_id: str, file_path: Path, content_sha256: str) -> None:
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO chunk_state (chunk_id, file_path, content_sha256, synced_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(chunk_id) DO UPDATE SET
                    file_path = excluded.file_path,
                    content_sha256 = excluded.content_sha256,
                    synced_at = excluded.synced_at
                """,
                (chunk_id, str(file_path), content_sha256, int(time.time())),
            )

    def record_file_sync(self, file_path: Path, mtime_ns: int, file_sha256: str) -> None:
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO file_state (file_path, mtime_ns, file_sha256, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET
                    mtime_ns = excluded.mtime_ns,
                    file_sha256 = excluded.file_sha256,
                    updated_at = excluded.updated_at
                """,
                (str(file_path), mtime_ns, file_sha256, int(time.time())),
            )

    def close(self) -> None:
        self.conn.close()


# ============================================================================
# 3. Semantic Chunking Engine (Python Stdlib AST + Markdown Header/Wikilink Parser)
# ============================================================================
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")
FRONTMATTER_RE = re.compile(r"\A---\s*\r?\n(.*?)\r?\n---\s*\r?\n", re.DOTALL)
HEADER_SPLIT_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.MULTILINE)


def normalize_slug(raw: str, prefix: str = "doc") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.\-/]+", "-", raw.strip().lower()).strip("-")
    return f"{prefix}:{cleaned or 'unnamed'}"


class SemanticChunker:
    """Extracts AST-bounded Python definitions and header-bounded Markdown sections."""

    def __init__(self, default_namespace: str) -> None:
        self.default_namespace = default_namespace

    def chunk_file(self, file_path: Path, watch_root: Path) -> list[SemanticChunk]:
        rel_path = file_path.relative_to(watch_root).as_posix()
        full_rel_key = f"{watch_root.name}/{rel_path}"
        source_text = file_path.read_text(encoding="utf-8", errors="replace")

        if not source_text.strip():
            return []

        if file_path.suffix.lower() == ".py":
            return self._chunk_python_ast(full_rel_key, source_text)
        if file_path.suffix.lower() == ".md":
            return self._chunk_markdown(full_rel_key, source_text)
        return []

    def _chunk_python_ast(self, rel_path: str, source_text: str) -> list[SemanticChunk]:
        try:
            tree = ast.parse(source_text, filename=rel_path)
        except SyntaxError as exc:
            logger.warning("Skipping Python file with SyntaxError (%s): %s", rel_path, exc)
            return []

        chunks: list[SemanticChunk] = []
        module_doc = ast.get_docstring(tree) or ""
        file_slug = normalize_slug(rel_path, prefix="module")

        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue

            node_name = node.name
            node_kind = "class" if isinstance(node, ast.ClassDef) else "function"
            segment = ast.get_source_segment(source_text, node)
            if not segment:
                continue

            docstring = ast.get_docstring(node) or ""
            chunk_id = hashlib.sha256(f"{rel_path}:{node_name}".encode("utf-8")).hexdigest()[:24]
            symbol_slug = normalize_slug(f"{rel_path}.{node_name}", prefix=node_kind)

            summary = (
                docstring.splitlines()[0].strip()
                if docstring.strip()
                else f"Python {node_kind} `{node_name}` defined in `{rel_path}`."
            )
            if len(summary) > 240:
                summary = f"{summary[:237]}..."

            header_context = f"# Module: `{rel_path}`\n"
            if module_doc:
                header_context += f"_{module_doc.splitlines()[0].strip()}_\n\n"

            content = f"{header_context}```python\n{segment.strip()}\n```"

            triples = [
                GraphTriplePayload(
                    subjectId=symbol_slug,
                    subjectName=f"{node_name} ({rel_path})",
                    subjectType="service" if node_kind == "class" else "concept",
                    relation="DEFINED_IN",
                    objectId=file_slug,
                    objectName=rel_path,
                    objectType="project",
                )
            ]

            chunks.append(
                SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=self.default_namespace,
                    memory_type="procedural",
                    title=f"{rel_path} :: {node_kind} {node_name}",
                    content=content,
                    summary=summary,
                    source_uri=f"rpi5://{rel_path}#L{node.lineno}",
                    importance=0.75,
                    triples=triples,
                )
            )

        # Fallback for script-style Python modules with no top-level classes/functions
        if not chunks:
            chunk_id = hashlib.sha256(f"{rel_path}:__module__".encode("utf-8")).hexdigest()[:24]
            summary = (
                module_doc.splitlines()[0].strip()
                if module_doc.strip()
                else f"Python module `{rel_path}`."
            )
            chunks.append(
                SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=self.default_namespace,
                    memory_type="procedural",
                    title=f"{rel_path} (module)",
                    content=f"```python\n{source_text[:4000].strip()}\n```",
                    summary=summary[:240],
                    source_uri=f"rpi5://{rel_path}",
                    importance=0.65,
                )
            )

        return chunks

    def _extract_frontmatter_tags(self, frontmatter: str) -> list[str]:
        tags: list[str] = []
        inline_match = re.search(r"^tags:\s*\[([^\]]*)\]", frontmatter, re.MULTILINE)
        if inline_match:
            for raw_tag in inline_match.group(1).split(","):
                cleaned = raw_tag.strip().strip("'\"")
                if cleaned:
                    tags.append(cleaned)
            return tags

        list_match = re.search(
            r"^tags:\s*\r?\n((?:[ \t]*-\s*.+\r?\n?)+)", frontmatter, re.MULTILINE
        )
        if list_match:
            for line in list_match.group(1).splitlines():
                cleaned = re.sub(r"^[ \t]*-\s*", "", line).strip().strip("'\"")
                if cleaned:
                    tags.append(cleaned)
        return tags

    def _chunk_markdown(self, rel_path: str, source_text: str) -> list[SemanticChunk]:
        tags: list[str] = []
        body = source_text
        fm_match = FRONTMATTER_RE.match(source_text)
        if fm_match:
            tags = self._extract_frontmatter_tags(fm_match.group(1))
            body = source_text[fm_match.end() :]

        file_slug = normalize_slug(rel_path, prefix="doc")
        file_name = Path(rel_path).stem

        # Split by ## and ### headers
        matches = list(HEADER_SPLIT_RE.finditer(body))
        sections: list[tuple[str, str]] = []

        if not matches:
            sections.append((file_name, body.strip()))
        else:
            preamble = body[: matches[0].start()].strip()
            if preamble:
                sections.append((f"{file_name} (Overview)", preamble))
            for idx, match in enumerate(matches):
                heading_title = match.group(2).strip()
                start = match.start()
                end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
                section_body = body[start:end].strip()
                if section_body:
                    sections.append((heading_title, section_body))

        chunks: list[SemanticChunk] = []
        for heading, section_text in sections:
            chunk_id = hashlib.sha256(
                f"{rel_path}:{heading}".encode("utf-8")
            ).hexdigest()[:24]

            triples: list[GraphTriplePayload] = []
            # Tag triples from YAML frontmatter
            for tag in tags:
                tag_slug = normalize_slug(tag, prefix="tag")
                triples.append(
                    GraphTriplePayload(
                        subjectId=file_slug,
                        subjectName=rel_path,
                        subjectType="project",
                        relation="TAGGED_WITH",
                        objectId=tag_slug,
                        objectName=tag,
                        objectType="concept",
                    )
                )

            # [[Wikilink]] triples
            for wl_match in WIKILINK_RE.finditer(section_text):
                target_raw = wl_match.group(1).strip()
                display_name = (wl_match.group(2) or target_raw).strip()
                wikilink_slug = normalize_slug(target_raw, prefix="doc")
                triples.append(
                    GraphTriplePayload(
                        subjectId=file_slug,
                        subjectName=rel_path,
                        subjectType="concept",
                        relation="LINKS_TO",
                        objectId=wikilink_slug,
                        objectName=display_name,
                        objectType="concept",
                    )
                )

            first_para = next(
                (
                    line.strip()
                    for line in section_text.splitlines()
                    if line.strip() and not line.strip().startswith("#")
                ),
                heading,
            )
            summary = first_para[:237] + "..." if len(first_para) > 240 else first_para
            tag_prefix = f"Tags: {', '.join(tags)}\n\n" if tags else ""

            chunks.append(
                SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=self.default_namespace,
                    memory_type="semantic",
                    title=f"{rel_path} :: {heading}",
                    content=f"{tag_prefix}{section_text}",
                    summary=summary,
                    source_uri=f"rpi5://{rel_path}#{normalize_slug(heading, prefix='sec')}",
                    importance=0.7,
                    triples=triples,
                )
            )

        return chunks


# ============================================================================
# 4. Streamable HTTP MCP Client with Exponential Backoff
# ============================================================================
class StreamableHttpMcpClient:
    """Pushes semantic chunks to the Cloudflare Worker MCP server via JSON-RPC 2.0."""

    def __init__(self, endpoint_url: str, bearer_token: str) -> None:
        self.endpoint_url = endpoint_url
        self.client = httpx.Client(
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={
                "Authorization": f"Bearer {bearer_token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "User-Agent": "rpi5-brain-watcher/1.0",
            },
        )
        self._req_id = 0

    def upsert_chunk(self, chunk: SemanticChunk, max_retries: int = 5) -> dict[str, Any]:
        self._req_id += 1
        arguments: dict[str, Any] = {
            "title": chunk.title,
            "content": chunk.content,
            "summary": chunk.summary,
            "namespace": chunk.namespace,
            "memoryType": chunk.memory_type,
            "sourceUri": chunk.source_uri,
            "importance": chunk.importance,
        }
        if chunk.triples:
            arguments["triples"] = [t.to_dict() for t in chunk.triples]

        rpc_payload = {
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": "tools/call",
            "params": {
                "name": "remember_fact",
                "arguments": arguments,
            },
        }

        backoff = 1.0
        for attempt in range(1, max_retries + 1):
            try:
                response = self.client.post(self.endpoint_url, json=rpc_payload)
                response.raise_for_status()
                return self._parse_streamable_response(response.text)
            except Exception as exc:
                if attempt == max_retries:
                    logger.error(
                        "Failed to sync chunk %s (%s) after %d attempts: %s",
                        chunk.chunk_id,
                        chunk.title,
                        max_retries,
                        exc,
                    )
                    raise
                sleep_sec = backoff * (2 ** (attempt - 1))
                logger.warning(
                    "Transient error syncing %s (attempt %d/%d): %s. Retrying in %.1fs...",
                    chunk.title,
                    attempt,
                    max_retries,
                    exc,
                    sleep_sec,
                )
                time.sleep(sleep_sec)
        return {}

    @staticmethod
    def _parse_streamable_response(raw_body: str) -> dict[str, Any]:
        for line in raw_body.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:].strip())
        return json.loads(raw_body) if raw_body.strip() else {}

    def close(self) -> None:
        self.client.close()


# ============================================================================
# 5. Watchdog File System Event Handler & Sync Orchestrator
# ============================================================================
class BrainDirectoryWatcher(FileSystemEventHandler):
    def __init__(
        self,
        watch_roots: list[Path],
        state_cache: LocalSyncStateCache,
        chunker: SemanticChunker,
        mcp_client: StreamableHttpMcpClient,
    ) -> None:
        super().__init__()
        self.watch_roots = watch_roots
        self.state_cache = state_cache
        self.chunker = chunker
        self.mcp_client = mcp_client

    def _should_process(self, path: Path) -> bool:
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return False
        if any(part in IGNORED_DIRS or part.startswith(".") for part in path.parts):
            return False
        return path.is_file()

    def _resolve_watch_root(self, file_path: Path) -> Path | None:
        for root in self.watch_roots:
            try:
                file_path.relative_to(root)
                return root
            except ValueError:
                continue
        return None

    def sync_file(self, file_path: Path) -> None:
        resolved = file_path.resolve()
        if not self._should_process(resolved):
            return

        watch_root = self._resolve_watch_root(resolved)
        if not watch_root:
            return

        try:
            stat = resolved.stat()
            raw_bytes = resolved.read_bytes()
        except OSError as exc:
            logger.debug("Unable to stat/read %s: %s", resolved, exc)
            return

        file_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        if self.state_cache.is_file_unchanged(resolved, stat.st_mtime_ns, file_sha256):
            return

        chunks = self.chunker.chunk_file(resolved, watch_root)
        synced_count = 0

        for chunk in chunks:
            chunk_hash = chunk.content_sha256
            if self.state_cache.is_chunk_unchanged(chunk.chunk_id, chunk_hash):
                continue

            self.mcp_client.upsert_chunk(chunk)
            self.state_cache.record_chunk_sync(chunk.chunk_id, resolved, chunk_hash)
            synced_count += 1

        self.state_cache.record_file_sync(resolved, stat.st_mtime_ns, file_sha256)
        if synced_count > 0:
            logger.info(
                "Synced %d modified semantic chunk(s) from %s",
                synced_count,
                resolved.relative_to(watch_root).as_posix(),
            )

    def initial_scan(self) -> None:
        for root in self.watch_roots:
            if not root.exists():
                logger.warning("Configured watch directory does not exist yet: %s", root)
                continue
            logger.info("Running initial semantic scan on %s...", root)
            for path in root.rglob("*"):
                if self._should_process(path):
                    try:
                        self.sync_file(path)
                    except Exception as exc:
                        logger.error("Error processing %s during initial scan: %s", path, exc)

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self.sync_file(Path(os.fsdecode(event.src_path)))

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self.sync_file(Path(os.fsdecode(event.src_path)))

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory and hasattr(event, "dest_path"):
            self.sync_file(Path(os.fsdecode(event.dest_path)))


def main() -> int:
    state_cache = LocalSyncStateCache(STATE_DB_PATH)
    chunker = SemanticChunker(default_namespace=DEFAULT_NAMESPACE)
    mcp_client = StreamableHttpMcpClient(
        endpoint_url=BRAIN_MCP_URL,
        bearer_token=MCP_BEARER_TOKEN,
    )
    handler = BrainDirectoryWatcher(
        watch_roots=WATCH_DIRS,
        state_cache=state_cache,
        chunker=chunker,
        mcp_client=mcp_client,
    )

    handler.initial_scan()

    observer = Observer()
    scheduled_dirs = 0
    for watch_dir in WATCH_DIRS:
        if watch_dir.exists():
            observer.schedule(handler, str(watch_dir), recursive=True)
            scheduled_dirs += 1
            logger.info("Watching directory: %s (namespace=%s)", watch_dir, DEFAULT_NAMESPACE)

    if scheduled_dirs == 0:
        logger.warning("No existing WATCH_DIRS found to monitor; exiting.")
        mcp_client.close()
        state_cache.close()
        return 0

    stop_requested = False

    def _handle_signal(signum: int, _frame: Any) -> None:
        nonlocal stop_requested
        logger.info("Received signal %d, shutting down brain_watcher...", signum)
        stop_requested = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    observer.start()
    try:
        while not stop_requested:
            time.sleep(1.0)
    finally:
        observer.stop()
        observer.join()
        mcp_client.close()
        state_cache.close()
        logger.info("brain_watcher stopped cleanly.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
