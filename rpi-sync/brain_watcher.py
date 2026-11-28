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

try:
    import httpx
    from watchdog.events import FileSystemEvent, FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError:
    httpx = None  # type: ignore[assignment]
    FileSystemEvent = Any  # type: ignore[misc,assignment]
    FileSystemEventHandler = object  # type: ignore[misc,assignment]
    Observer = None  # type: ignore[assignment]

# =============================================================================
# CONFIGURATION BLOCK (ENVIRONMENT VARIABLES)
# =============================================================================
RPI_SYNC_ENABLED: bool = os.environ.get("RPI_SYNC_ENABLED", "true").strip().lower() in (
    "1",
    "true",
    "yes",
)
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

# RPi5 Antigravity / Gemini CLI Session Harvester Configuration
CLI_SYNC_ENABLED: bool = os.environ.get("CLI_SYNC_ENABLED", "true").strip().lower() in (
    "1",
    "true",
    "yes",
)
CLI_CLIENT_ID: str = os.environ.get("CLI_CLIENT_ID", "antigravity-cli-rpi5").strip() or "antigravity-cli-rpi5"
CLI_GEMINI_DIR: Path = Path(
    os.environ.get("CLI_GEMINI_DIR", str(Path.home() / ".gemini"))
).expanduser()
CLI_SYNC_INTERVAL_SEC: float = float(os.environ.get("CLI_SYNC_INTERVAL_SEC", "900.0"))
CLI_LOOKBACK_HOURS: float = float(os.environ.get("CLI_LOOKBACK_HOURS", "48.0"))
CLI_SESSION_IDLE_SEC: float = float(os.environ.get("CLI_SESSION_IDLE_SEC", "180.0"))

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
    "takeout-staging",
    "takeout-output",
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
                synced_at INTEGER NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'homelab'
            )
            """
        )
        # Idempotent migration for existing sync_state.db files without namespace column
        cols = {
            row[1]
            for row in self.conn.execute("PRAGMA table_info(synced_chunks)").fetchall()
        }
        if "namespace" not in cols:
            self.conn.execute(
                "ALTER TABLE synced_chunks ADD COLUMN namespace TEXT NOT NULL DEFAULT 'homelab'"
            )
        self.conn.commit()

    def is_unchanged(
        self, chunk_id: str, content_sha256: str, namespace: str | None = None
    ) -> bool:
        cur = self.conn.execute(
            "SELECT content_sha256, namespace FROM synced_chunks WHERE chunk_id = ?",
            (chunk_id,),
        )
        row = cur.fetchone()
        if not row or row[0] != content_sha256:
            return False
        if namespace is not None and (row[1] or DEFAULT_NAMESPACE) != namespace:
            return False
        return True

    def mark_synced(
        self,
        chunk_id: str,
        source_uri: str,
        content_sha256: str,
        namespace: str = DEFAULT_NAMESPACE,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO synced_chunks (chunk_id, source_uri, content_sha256, synced_at, namespace)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                source_uri = excluded.source_uri,
                content_sha256 = excluded.content_sha256,
                synced_at = excluded.synced_at,
                namespace = excluded.namespace
            """,
            (chunk_id, source_uri, content_sha256, int(time.time()), namespace),
        )
        self.conn.commit()


# =============================================================================
# DETERMINISTIC CATEGORY & PATH -> NAMESPACE ROUTER
# =============================================================================
VALID_NAMESPACES: set[str] = {
    "global",
    "tsimon.me",
    "minkalab.net",
    "homelab",
    "ai-research",
    "career",
}

_PROTECTED_HOMELAB_RE = re.compile(
    r"(node:rpi5|rpi5-qdrant-knowledge-hub|edge-rag-hub|edge-semantic-search-rag|"
    r"homelab-backup|homelab-ops|raspberry-pi-backup|backup-pi-restic|cf-state-backup|"
    r"r2-offsite-sync|pi-apps-backup)",
    re.IGNORECASE,
)
_MINKALAB_RE = re.compile(
    r"(minkalab|minka[\s_-]lab|mallasa|escudo[\s_-]digital|gamlp|"
    r"ciudad[\s_-]inteligente|ciudadan[ií]a[\s_-]digital)",
    re.IGNORECASE,
)
_TSIMON_RE = re.compile(
    r"(boliviaremote\.work|bolivia-remote|gemini[\s_-]brain|brain\.tsimon\.me|"
    r"kb\.tsimon\.me|archive-rag-kb|tsimon\.me|tsimon-me-website)",
    re.IGNORECASE,
)
_CAREER_RE = re.compile(
    r"(az-?104|azure[\s_-]az-?104|microsoft and certifications|certification_path|"
    r"learning_roadmap|career|freelanc|resume|pivot_strategy|short_term_strategy|"
    r"hiring_non-us_contractor|mssp_consulting|data_engineer|ai_infrastructure_engineer|"
    r"ai_solutions_engineer|synquery|outlier|innodata|personal profile summary)",
    re.IGNORECASE,
)
_AI_RESEARCH_RE = re.compile(
    r"(ai_agents|ai_core_concepts|neural networks|karpathy|behavioral_harness|"
    r"harness_concepts|context_engineering|context tunning|context tuning|"
    r"export gemini skills|automated ai research|qdrant_documentation|"
    r"agentic workflows|01_ai[\s_-]|llm|rag[\s_-]pipeline|latam_solo_founder|"
    r"south america tech funding)",
    re.IGNORECASE,
)


def extract_frontmatter_namespace(text: str) -> str | None:
    fm_match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, flags=re.DOTALL)
    if not fm_match:
        return None
    ns_match = re.search(
        r"^\s*namespace\s*:\s*['\"]?([^'\"\r\n#]+)['\"]?",
        fm_match.group(1),
        flags=re.MULTILINE | re.IGNORECASE,
    )
    if ns_match:
        val = ns_match.group(1).strip().lower()
        if val in VALID_NAMESPACES:
            return val
    return None


def resolve_namespace(
    category: str = "",
    source: str = "",
    title: str = "",
    default_namespace: str = DEFAULT_NAMESPACE,
    explicit_namespace: str | None = None,
) -> str:
    """Routes Qdrant points and watched Markdown/Python files into their canonical Brain namespace."""
    if explicit_namespace and explicit_namespace.strip().lower() in VALID_NAMESPACES:
        return explicit_namespace.strip().lower()

    cat = (category or "").strip().lower()
    blob = f"{source or ''} {title or ''}".strip()

    # Keep protected RPi5 / Edge RAG / Homelab backup infrastructure anchored in homelab
    if _PROTECTED_HOMELAB_RE.search(blob) and not _MINKALAB_RE.search(cat):
        return "homelab"

    # 1. Explicit domain categories from Qdrant payloads
    if "minkalab" in cat:
        return "minkalab.net"
    if cat in ("boliviaremote.work", "tsimon.me"):
        return "tsimon.me"
    if cat in ("career", "microsoft"):
        return "career"
    if cat in ("ai", "ai research", "ai-research"):
        if _MINKALAB_RE.search(blob):
            return "minkalab.net"
        if _TSIMON_RE.search(blob):
            return "tsimon.me"
        if _CAREER_RE.search(blob):
            return "career"
        return "ai-research"

    # 2. Path/title routing for generic categories (Documentation, General, Programming, etc.) & watched files
    if _MINKALAB_RE.search(blob):
        return "minkalab.net"
    if _TSIMON_RE.search(blob):
        return "tsimon.me"
    if _CAREER_RE.search(blob):
        return "career"
    if _AI_RESEARCH_RE.search(blob):
        return "ai-research"

    return default_namespace if default_namespace in VALID_NAMESPACES else "homelab"


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


def chunk_python_file(
    file_path: Path, rel_path: str, namespace: str, id_namespace: str | None = None
) -> list[SemanticChunk]:
    source = file_path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(source, filename=rel_path)
    except SyntaxError as exc:
        logger.warning("Skipping Python file with syntax error %s: %s", rel_path, exc)
        return []

    chunks: list[SemanticChunk] = []
    file_entity_id = f"file:{slugify(rel_path)}"
    stable_id_ns = id_namespace or namespace

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            node_kind = "class" if isinstance(node, ast.ClassDef) else "function"
            segment = ast.get_source_segment(source, node) or ""
            if not segment.strip():
                continue

            docstring = ast.get_docstring(node) or f"Python {node_kind} {node.name} in {rel_path}"
            first_line = docstring.strip().splitlines()[0][:240]
            chunk_id = make_chunk_id("py", f"{stable_id_ns}:{rel_path}:{node.name}")
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


def chunk_markdown_file(
    file_path: Path, rel_path: str, namespace: str, id_namespace: str | None = None
) -> list[SemanticChunk]:
    text = file_path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return []
    stable_id_ns = id_namespace or namespace

    matches = list(MD_HEADER_RE.finditer(text))
    # Each section stores: (full_breadcrumb, display_heading, leaf_heading, anchor_base, section_body)
    sections: list[tuple[str, str, str, str, str]] = []

    if not matches:
        stem_slug = slugify(file_path.stem)
        sections.append((file_path.stem, file_path.stem, file_path.stem, stem_slug, text.strip()))
    else:
        heading_stack: list[tuple[int, str]] = []
        for idx, match in enumerate(matches):
            level = len(match.group(1))
            heading_title = match.group(2).strip()

            # Always update the heading hierarchy stack even if this section's body
            # is short (< 40 chars) so nested subheadings inherit their true parent.
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, heading_title))

            start = match.start()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
            section_body = text[start:end].strip()
            if len(section_body) >= 40:
                breadcrumb = " > ".join(h for _, h in heading_stack)
                display_heading = " › ".join(h for _, h in heading_stack[-2:])
                anchor_base = "--".join(
                    slugify(h)[:60].rstrip("-") for _, h in heading_stack[-2:]
                )
                sections.append((breadcrumb, display_heading, heading_title, anchor_base, section_body))

    chunks: list[SemanticChunk] = []
    doc_entity_id = f"doc:{slugify(file_path.stem)}"
    seen_breadcrumbs: dict[str, int] = {}

    for breadcrumb, display_heading, leaf_heading, anchor_base, body in sections:
        occurrence = seen_breadcrumbs.get(breadcrumb, 0) + 1
        seen_breadcrumbs[breadcrumb] = occurrence
        unique_breadcrumb = breadcrumb if occurrence == 1 else f"{breadcrumb} #{occurrence}"

        chunk_id = make_chunk_id("md", f"{stable_id_ns}:{rel_path}:{unique_breadcrumb}")
        anchor = anchor_base if occurrence == 1 else f"{anchor_base}-{occurrence}"
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
        summary = (plain_lines[0] if plain_lines else leaf_heading)[:240]

        chunks.append(
            SemanticChunk(
                chunk_id=chunk_id,
                namespace=namespace,
                memory_type="semantic",
                title=f"{file_path.stem} — {display_heading}",
                content=body,
                summary=summary,
                source_uri=f"rpi5://{rel_path}#{anchor}",
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

                target_namespace = resolve_namespace(
                    category=category,
                    source=source,
                    title=raw_title,
                    default_namespace=self.namespace,
                )

                chunk = SemanticChunk(
                    chunk_id=chunk_id,
                    namespace=target_namespace,
                    memory_type=memory_type,
                    title=title,
                    content=content,
                    summary=summary,
                    source_uri=source_uri,
                    importance=0.82,
                    triples=triples,
                )

                sha = chunk.content_sha256
                if self.state_db.is_unchanged(chunk.chunk_id, sha, namespace=chunk.namespace):
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
                        "clientId": f"{CLIENT_ID}-qdrant",
                        "importance": chunk.importance,
                        "triples": chunk.triples,
                    },
                )
                self.state_db.mark_synced(
                    chunk.chunk_id, chunk.source_uri, sha, namespace=chunk.namespace
                )
                synced_count += 1
                logger.info(
                    "Federated Qdrant point [%s -> %s] %s (%d/%d)",
                    self.collection,
                    chunk.namespace,
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

        explicit_ns: str | None = None
        if file_path.suffix.lower() == ".md":
            try:
                head_text = file_path.read_text(encoding="utf-8", errors="replace")[:2000]
                explicit_ns = extract_frontmatter_namespace(head_text)
            except OSError:
                explicit_ns = None

        target_ns = resolve_namespace(
            source=rel_path,
            title=file_path.stem,
            default_namespace=self.namespace,
            explicit_namespace=explicit_ns,
        )

        if file_path.suffix.lower() == ".py":
            chunks = chunk_python_file(
                file_path, rel_path, target_ns, id_namespace=self.namespace
            )
        else:
            chunks = chunk_markdown_file(
                file_path, rel_path, target_ns, id_namespace=self.namespace
            )

        synced_count = 0
        for chunk in chunks:
            sha = chunk.content_sha256
            if self.state_db.is_unchanged(chunk.chunk_id, sha, namespace=chunk.namespace):
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
                    "clientId": CLIENT_ID,
                    "importance": chunk.importance,
                    "triples": chunk.triples,
                },
            )
            self.state_db.mark_synced(
                chunk.chunk_id, chunk.source_uri, sha, namespace=chunk.namespace
            )
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


# =============================================================================
# RPI5 ANTIGRAVITY / GEMINI CLI TRANSCRIPT HARVESTER
# =============================================================================
class RpiCliSessionHarvester:
    """Harvests idle Antigravity CLI & Gemini CLI session transcripts on RPi5 into BrainMemoryDO episodic_logs."""

    def __init__(
        self,
        gemini_dir: Path,
        client_id: str,
        lookback_hours: float,
        idle_seconds: float,
        state_db: LocalSyncStateDB,
        mcp: BrainMcpClient,
    ) -> None:
        self.gemini_dir = gemini_dir
        self.client_id = client_id
        self.lookback_hours = lookback_hours
        self.idle_seconds = idle_seconds
        self.state_db = state_db
        self.mcp = mcp

    @staticmethod
    def _clean_user_text(raw: str) -> str:
        text = raw or ""
        m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, flags=re.DOTALL)
        if m:
            text = m.group(1)
        else:
            text = re.sub(r"<CONTEXT_SUMMARY>.*?</CONTEXT_SUMMARY>", "", text, flags=re.DOTALL)
            text = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", text, flags=re.DOTALL)
            text = re.sub(r"<session_context>.*?</session_context>", "", text, flags=re.DOTALL)
        return re.sub(r"\s+", " ", text).strip()

    @staticmethod
    def _extract_gcli_text(content: Any) -> str:
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

    def _parse_antigravity_transcript(self, path: Path) -> tuple[list[str], list[str], str]:
        user_prompts: list[str] = []
        assistant_responses: list[str] = []
        last_created_at = ""
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return [], [], time.strftime("%Y-%m-%d", time.gmtime())

        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            created_at = obj.get("created_at")
            if isinstance(created_at, str) and len(created_at) >= 10:
                last_created_at = created_at[:10]
            step_type = obj.get("type", "")
            content = obj.get("content", "")
            if not isinstance(content, str) or not content.strip():
                continue
            if step_type == "USER_INPUT":
                cleaned = self._clean_user_text(content)
                if cleaned and (not user_prompts or user_prompts[-1] != cleaned):
                    user_prompts.append(cleaned)
            elif step_type == "PLANNER_RESPONSE":
                cleaned = re.sub(r"\s+", " ", content).strip()
                if cleaned and len(cleaned) > 25:
                    assistant_responses.append(cleaned)

        iso_date = last_created_at or time.strftime("%Y-%m-%d", time.gmtime(path.stat().st_mtime))
        return user_prompts, assistant_responses, iso_date

    def _parse_gemini_cli_transcript(self, path: Path) -> tuple[str, list[str], list[str], str]:
        project_slug = path.parent.parent.name
        session_id = f"gcli-rpi5-{project_slug}-{path.stem}"
        user_prompts: list[str] = []
        assistant_responses: list[str] = []
        last_updated = ""
        try:
            raw_text = path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            return session_id, [], [], time.strftime("%Y-%m-%d", time.gmtime())
        if not raw_text:
            return session_id, [], [], time.strftime("%Y-%m-%d", time.gmtime())

        messages: list[dict[str, Any]] = []
        if path.suffix == ".json":
            try:
                data = json.loads(raw_text)
                if isinstance(data, dict):
                    messages = data.get("messages", [])
                    last_updated = str(data.get("lastUpdated") or data.get("startTime") or "")
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
                    last_updated = str(obj.get("lastUpdated") or "")
                if "$set" in obj and isinstance(obj["$set"], dict):
                    if isinstance(obj["$set"].get("messages"), list):
                        messages = obj["$set"]["messages"]
                    if "lastUpdated" in obj["$set"]:
                        last_updated = str(obj["$set"].get("lastUpdated") or "")
                elif isinstance(obj.get("messages"), list):
                    messages = obj["messages"]

        for msg in messages:
            if not isinstance(msg, dict):
                continue
            mtype = str(msg.get("type") or msg.get("role") or "").lower()
            raw_content = self._extract_gcli_text(msg.get("content"))
            if not raw_content:
                continue
            if mtype in ("user", "human"):
                cleaned = self._clean_user_text(raw_content)
                if cleaned and (not user_prompts or user_prompts[-1] != cleaned):
                    user_prompts.append(cleaned)
            elif mtype in ("gemini", "model", "assistant"):
                cleaned = re.sub(r"\s+", " ", raw_content).strip()
                if cleaned and len(cleaned) > 25:
                    assistant_responses.append(cleaned)

        iso_date = (
            last_updated[:10]
            if len(last_updated) >= 10
            else time.strftime("%Y-%m-%d", time.gmtime(path.stat().st_mtime))
        )
        return session_id, user_prompts, assistant_responses, iso_date

    def _build_payload(
        self,
        session_id: str,
        iso_date: str,
        source_label: str,
        user_prompts: list[str],
        assistant_responses: list[str],
    ) -> str:
        header = (
            f"RPi5 CLI Session Checkpoint ({iso_date} | client: {self.client_id} | "
            f"source: {source_label} | session: {session_id}):"
        )
        req_lines = [f"User Requests ({len(user_prompts)} turns):"]
        for idx, prompt in enumerate(user_prompts[:12], start=1):
            snippet = prompt[:240] + ("..." if len(prompt) > 240 else "")
            req_lines.append(f"  {idx}. {snippet}")

        selected = (
            assistant_responses
            if len(assistant_responses) <= 4
            else [assistant_responses[0]] + assistant_responses[-3:]
        )
        outcome_lines = ["Key Assistant Outcomes & Findings:"]
        if not selected:
            outcome_lines.append("  - Session contained user prompts without recorded text responses.")
        else:
            for resp in selected:
                snippet = resp[:500] + ("..." if len(resp) > 500 else "")
                outcome_lines.append(f"  - {snippet}")

        return "\n".join([header, "\n".join(req_lines), "\n".join(outcome_lines)])[:4000]

    def sync_sessions(self) -> int:
        if not self.gemini_dir.exists():
            logger.debug("CLI_GEMINI_DIR %s not found; skipping RPi5 CLI harvest.", self.gemini_dir)
            return 0

        now = time.time()
        cutoff_ts = now - (self.lookback_hours * 3600.0)
        candidates: list[tuple[str, str, list[str], list[str], str]] = []

        # 1. Antigravity CLI transcripts (~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl)
        agy_brain_root = self.gemini_dir / "antigravity-cli" / "brain"
        if agy_brain_root.is_dir():
            for sdir in sorted(agy_brain_root.iterdir()):
                if not sdir.is_dir() or sdir.name == "tempmediaStorage":
                    continue
                tpath = sdir / ".system_generated" / "logs" / "transcript.jsonl"
                if not tpath.is_file():
                    continue
                try:
                    mtime = tpath.stat().st_mtime
                except OSError:
                    continue
                if mtime < cutoff_ts or (now - mtime) < self.idle_seconds:
                    continue
                prompts, responses, iso_date = self._parse_antigravity_transcript(tpath)
                if prompts:
                    candidates.append((sdir.name, "antigravity-cli", prompts, responses, iso_date))

        # 2. Gemini CLI transcripts (~/.gemini/tmp/<project>/chats/session-*.jsonl & *.json)
        tmp_root = self.gemini_dir / "tmp"
        if tmp_root.is_dir():
            for pdir in sorted(tmp_root.iterdir()):
                chats_dir = pdir / "chats"
                if not chats_dir.is_dir():
                    continue
                for cfile in sorted(chats_dir.glob("session-*.*")):
                    if cfile.suffix not in (".jsonl", ".json"):
                        continue
                    try:
                        mtime = cfile.stat().st_mtime
                    except OSError:
                        continue
                    if mtime < cutoff_ts or (now - mtime) < self.idle_seconds:
                        continue
                    sid, prompts, responses, iso_date = self._parse_gemini_cli_transcript(cfile)
                    if prompts:
                        candidates.append((sid, f"gemini-cli/{pdir.name}", prompts, responses, iso_date))

        synced_count = 0
        for session_id, source_label, prompts, responses, iso_date in candidates:
            payload = self._build_payload(session_id, iso_date, source_label, prompts, responses)
            sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            state_key = f"cli_session:{session_id}"
            if self.state_db.is_unchanged(state_key, sha):
                continue

            self.mcp.call_tool(
                "log_episodic_event",
                {
                    "sessionId": session_id,
                    "clientId": self.client_id,
                    "eventType": "checkpoint",
                    "payload": payload,
                },
            )
            self.state_db.mark_synced(state_key, f"rpi5-cli://{source_label}/{session_id}", sha)
            synced_count += 1
            logger.info(
                "Harvested RPi5 CLI session [%s] %s (%d turns)",
                self.client_id,
                session_id,
                len(prompts),
            )

        if synced_count > 0:
            logger.info(
                "RPi5 CLI session harvest complete (%s): synced=%d",
                self.client_id,
                synced_count,
            )
        return synced_count


def main() -> None:
    if not RPI_SYNC_ENABLED:
        logger.info(
            "Raspberry Pi 5 sync & Qdrant federation is disabled (RPI_SYNC_ENABLED=false). Exiting cleanly."
        )
        return

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
    cli_harvester = RpiCliSessionHarvester(
        gemini_dir=CLI_GEMINI_DIR,
        client_id=CLI_CLIENT_ID,
        lookback_hours=CLI_LOOKBACK_HOURS,
        idle_seconds=CLI_SESSION_IDLE_SEC,
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

    # Harvest idle RPi5 Antigravity / Gemini CLI sessions into BrainMemoryDO episodic_logs
    total_cli_sessions = cli_harvester.sync_sessions() if CLI_SYNC_ENABLED else 0
    last_cli_sync = time.monotonic()

    if (total_initial_chunks + total_qdrant_chunks) > 0:
        mcp.call_tool(
            "log_episodic_event",
            {
                "sessionId": f"boot-{int(time.time())}",
                "clientId": CLIENT_ID,
                "eventType": "checkpoint",
                "payload": (
                    f"Raspberry Pi 5 daemon synced {total_initial_chunks} filesystem chunks, "
                    f"federated {total_qdrant_chunks} Qdrant ({qdrant_collection}) points, "
                    f"and harvested {total_cli_sessions} CLI sessions ({CLI_CLIENT_ID})."
                ),
            },
        )

    observer.start()
    logger.info(
        "Raspberry Pi 5 Brain Watcher + Qdrant Federator + CLI Harvester (%s) is active. Press Ctrl+C to stop.",
        CLI_CLIENT_ID,
    )
    try:
        while True:
            time.sleep(5)
            now_mono = time.monotonic()
            if now_mono - last_qdrant_sync >= QDRANT_SYNC_INTERVAL_SEC:
                federator.sync_collection()
                last_qdrant_sync = now_mono
            if CLI_SYNC_ENABLED and now_mono - last_cli_sync >= CLI_SYNC_INTERVAL_SEC:
                cli_harvester.sync_sessions()
                last_cli_sync = now_mono
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
