/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\schema.ts
 * Purpose: Embedded Durable Object SQLite Schema (FTS5 + Knowledge Graph + ADR + Episodic)
 *          and parameterized SQL queries for hybrid lexical + graph retrieval.
 */

export const SCHEMA_DDL = `
-- 1. Core Semantic & Procedural Memory Chunks
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,                      -- Deterministic SHA-256 hash or UUID
    namespace TEXT NOT NULL DEFAULT 'global', -- e.g., 'global', 'tsimon.me', 'minkalab.net', 'homelab'
    memory_type TEXT NOT NULL DEFAULT 'semantic', -- 'semantic' | 'procedural' | 'episodic_summary'
    title TEXT NOT NULL,
    content TEXT NOT NULL,                    -- Full Markdown or AST code block
    summary TEXT,                             -- Condensed 1-2 sentence representation for token packing
    source_uri TEXT,                          -- File path, git commit URI, or session ID
    token_count INTEGER NOT NULL DEFAULT 0,   -- Pre-calculated token length for budget packing
    importance REAL NOT NULL DEFAULT 0.5,     -- 0.0 to 1.0 priority weight
    confidence REAL NOT NULL DEFAULT 1.0,     -- Epistemic certainty (0.0 to 1.0)
    access_count INTEGER NOT NULL DEFAULT 0,  -- Incremented on recall (synaptic reinforcement)
    superseded_by TEXT REFERENCES memories(id), -- Null if active; points to newer memory ID if deprecated
    metadata_json TEXT DEFAULT '{}',          -- Arbitrary JSON attributes (tags, language, device)
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_memories_ns_active
    ON memories(namespace, superseded_by, updated_at DESC);

-- 2. FTS5 Virtual Table for BM25 Lexical & Exact Identifier Search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    namespace UNINDEXED,
    title,
    content,
    summary,
    tokenize='porter unicode61 remove_diacritics 2'
);

-- Synchronization Triggers: Keep memories_fts strictly aligned with active memories
CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories
WHEN NEW.superseded_by IS NULL
BEGIN
    INSERT INTO memories_fts(rowid, id, namespace, title, content, summary)
    VALUES (NEW.rowid, NEW.id, NEW.namespace, NEW.title, NEW.content, COALESCE(NEW.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories
BEGIN
    DELETE FROM memories_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories
BEGIN
    DELETE FROM memories_fts WHERE rowid = OLD.rowid;
    INSERT INTO memories_fts(rowid, id, namespace, title, content, summary)
    SELECT NEW.rowid, NEW.id, NEW.namespace, NEW.title, NEW.content, COALESCE(NEW.summary, '')
    WHERE NEW.superseded_by IS NULL;
END;

-- 3. Knowledge Graph Entities (Nodes)
CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,               -- Normalized slug (e.g., 'node:rpi5', 'domain:tsimon.me')
    namespace TEXT NOT NULL DEFAULT 'global',
    entity_type TEXT NOT NULL,                -- 'device' | 'service' | 'domain' | 'project' | 'concept' | 'person'
    canonical_name TEXT NOT NULL,
    description TEXT,
     pagerank_score REAL NOT NULL DEFAULT 0.15, -- Centrality score updated during nocturnal consolidation
    attributes_json TEXT DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entities_ns_type ON entities(namespace, entity_type);

-- 4. Knowledge Graph Relations (Directed Weighted Edges / Triples)
CREATE TABLE IF NOT EXISTS edges (
    edge_id TEXT PRIMARY KEY,                 -- Deterministic: source_entity || '|' || relation || '|' || target_entity
    namespace TEXT NOT NULL DEFAULT 'global',
    source_entity TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    relation TEXT NOT NULL,                   -- e.g., 'ROUTES_TO', 'RUNS_ON', 'GOVERNED_BY', 'DEPENDS_ON'
    target_entity TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 1.0,
    evidence_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    valid_from INTEGER NOT NULL DEFAULT (unixepoch()),
    valid_until INTEGER                       -- NULL = currently valid fact; timestamp = historical/superseded
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(namespace, source_entity, valid_until);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(namespace, target_entity, valid_until);
CREATE INDEX IF NOT EXISTS idx_edges_evidence ON edges(evidence_memory_id);

-- 5. Architecture Decision Records (ADRs) for Deterministic Rule Enforcement
CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'global',
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'superseded' | 'deprecated'
    superseded_by TEXT REFERENCES decisions(decision_id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 6. Episodic Session Logs (Raw Buffer for Nocturnal 03:00 Alarm Consolidation)
CREATE TABLE IF NOT EXISTS episodic_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    client_id TEXT NOT NULL,                  -- 'antigravity-win11-1', 'gemini-cli', 'rpi5-daemon'
    event_type TEXT NOT NULL,                 -- 'tool_call', 'observation', 'checkpoint', 'error_resolution'
    payload TEXT NOT NULL,
    consolidated INTEGER NOT NULL DEFAULT 0,  -- 0 = pending nocturnal sleep cycle; 1 = consolidated
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_episodic_unconsolidated
    ON episodic_logs(consolidated, created_at ASC);
`;

/**
 * SQL Query 1: Lexical BM25 + Temporal Decay + Importance Scoring
 * Note: SQLite FTS5 bm25() returns negative values where more negative = better match.
 * We negate bm25() and normalize across column weights (title=10.0, summary=5.0, content=1.0).
 * Parameters:
 *   ?1 = FTS5 match expression (e.g., '"cloudflare" OR "durable" OR "sqlite"')
 *   ?2 = namespace ('global' or specific project namespace)
 *   ?3 = current unix timestamp (seconds)
 *   ?4 = half_life_seconds (e.g., 2592000 for 30-day decay)
 *   ?5 = limit (e.g., 25)
 */
export const LEXICAL_HYBRID_SQL = `
WITH fts_matches AS MATERIALIZED (
    SELECT
        rowid,
        (-1.0 * bm25(memories_fts, 0.0, 0.0, 10.0, 1.0, 5.0)) AS raw_bm25
    FROM memories_fts
    WHERE memories_fts MATCH ?1
    ORDER BY rank
    LIMIT 100
)
SELECT
    m.id,
    m.namespace,
    m.memory_type,
    m.title,
    m.content,
    m.summary,
    m.source_uri,
    m.token_count,
    m.importance,
    m.confidence,
    m.access_count,
    m.updated_at,
    f.raw_bm25,
    EXP(-0.693147 * MAX(0, (?3 - m.updated_at)) / ?4) AS recency_decay,
    ROW_NUMBER() OVER (ORDER BY f.raw_bm25 DESC) AS lexical_rank
FROM fts_matches f
JOIN memories m ON m.rowid = f.rowid
WHERE (?2 = 'global' OR m.namespace = ?2 OR m.namespace = 'global')
  AND m.superseded_by IS NULL
ORDER BY lexical_rank ASC
LIMIT ?5;
`;

/**
 * SQL Query 2: 1-Hop & 2-Hop Knowledge Graph Subgraph Expansion
 * Expands active relational triples connected to either the recalled memory IDs
 * or entities explicitly mentioned in the query string.
 * Parameters:
 *   ?1 = JSON array of seed memory IDs (e.g., '["mem_1","mem_2"]')
 *   ?2 = JSON array of matched entity slugs or terms (e.g., '["domain:tsimon.me","node:rpi5"]')
 *   ?3 = namespace
 *   ?4 = max triples to return (e.g., 20)
 */
export const GRAPH_EXPANSION_SQL = `
WITH seed_entities AS (
    SELECT DISTINCT source_entity AS entity_id
    FROM edges
    WHERE evidence_memory_id IN (SELECT value FROM json_each(?1))
      AND valid_until IS NULL
    UNION
    SELECT DISTINCT target_entity AS entity_id
    FROM edges
    WHERE evidence_memory_id IN (SELECT value FROM json_each(?1))
      AND valid_until IS NULL
    UNION
    SELECT entity_id
    FROM entities
    WHERE entity_id IN (SELECT value FROM json_each(?2))
       OR LOWER(canonical_name) IN (SELECT LOWER(value) FROM json_each(?2))
)
SELECT DISTINCT
    e.edge_id,
    s.canonical_name AS subject_name,
    e.source_entity AS subject_id,
    e.relation,
    t.canonical_name AS object_name,
    e.target_entity AS object_id,
    e.weight,
    (s.pagerank_score + t.pagerank_score) * e.weight AS graph_salience,
    e.evidence_memory_id
FROM edges e
JOIN entities s ON s.entity_id = e.source_entity
JOIN entities t ON t.entity_id = e.target_entity
WHERE e.valid_until IS NULL
  AND (?3 = 'global' OR e.namespace = ?3 OR e.namespace = 'global')
  AND (
      e.source_entity IN (SELECT entity_id FROM seed_entities)
      OR e.target_entity IN (SELECT entity_id FROM seed_entities)
  )
ORDER BY graph_salience DESC
LIMIT ?4;
`;