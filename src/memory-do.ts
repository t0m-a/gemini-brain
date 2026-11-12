/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\memory-do.ts
 * Purpose: Stateful Durable Object implementing Federated 4-Way Hybrid Search
 *          (DO SQLite FTS5 + Brain Vectorize 1024-dim + D1 archive-knowledge-db FTS5 +
 *          KB Vectorize 768-dim + 1-Hop Knowledge Graph + Token-Budgeted RRF Compilation).
 */

import { DurableObject } from "cloudflare:workers";
import { SCHEMA_DDL, LEXICAL_HYBRID_SQL, GRAPH_EXPANSION_SQL } from "./schema";
import {
  buildSafeFts5Query,
  estimateTokens,
  fuseBrainAndKb,
  queryKbArchive,
  type RankedCandidate
} from "./federation";

export interface Env {
  BRAIN_DO: DurableObjectNamespace<BrainMemoryDO>;
  VECTOR_INDEX: VectorizeIndex;
  KB_DB: D1Database;
  KB_VECTORIZE: VectorizeIndex;
  AI: Ai;
  DEFAULT_NAMESPACE: string;
  PRIMARY_DOMAIN: string;
  EMBEDDING_MODEL: string;
  KB_EMBEDDING_MODEL: string;
  RERANKER_MODEL: string;
  MCP_BEARER_TOKEN?: string;
}

export type MemoryRecord = {
  id: string;
  namespace: string;
  memory_type: "semantic" | "procedural" | "episodic_summary";
  title: string;
  content: string;
  summary: string | null;
  source_uri: string | null;
  token_count: number;
  importance: number;
  confidence: number;
  access_count: number;
  updated_at: number;
};

export interface HybridRecallParams {
  query: string;
  namespace?: string;
  tokenBudget?: number;
  halfLifeDays?: number;
  topK?: number;
}

export type GraphTriple = {
  subject_name: string;
  relation: string;
  object_name: string;
  graph_salience: number;
};

export type EpisodicLogRow = {
  log_id: number;
  session_id: string;
  client_id: string;
  event_type: "tool_call" | "observation" | "checkpoint" | "error_resolution";
  payload: string;
  created_at: number;
};

export type ActiveDecisionRow = {
  decision_id: string;
  title: string;
  decision: string;
  rationale: string;
  created_at: number;
};

export class BrainMemoryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize embedded SQLite schema atomically before handling requests
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.sql.exec(SCHEMA_DDL);
      });
      await this.ensureAlarmScheduled();
    });
  }

  /**
   * Computes the Unix timestamp in milliseconds for the next occurrence of 07:00:00 UTC (03:00 AM America/La_Paz).
   */
  private getNext0700UtcMs(): number {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0, 0)
    );
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime();
  }

  /**
   * Ensures a single Durable Object consolidation alarm is scheduled without overwriting an active alarm.
   */
  private async ensureAlarmScheduled(): Promise<number> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      const nextMs = this.getNext0700UtcMs();
      await this.ctx.storage.setAlarm(nextMs);
      return nextMs;
    }
    return currentAlarm;
  }

  /**
   * RPC Method 1: Upsert a Semantic Memory + Knowledge Graph Triples + Vector Embedding
   */
  async rememberFact(input: {
    id?: string;
    namespace?: string;
    memoryType?: "semantic" | "procedural" | "episodic_summary";
    title: string;
    content: string;
    summary?: string;
    sourceUri?: string;
    importance?: number;
    confidence?: number;
    triples?: Array<{
      subjectId: string;
      subjectName: string;
      subjectType?: string;
      relation: string;
      objectId: string;
      objectName: string;
      objectType?: string;
    }>;
  }): Promise<{ id: string; tokenCount: number; indexedVectors: number }> {
    const namespace = input.namespace || this.env.DEFAULT_NAMESPACE || "global";
    const memoryType = input.memoryType || "semantic";
    const id = input.id || crypto.randomUUID();
    const summary =
      input.summary ||
      (input.content.length > 280 ? `${input.content.slice(0, 277)}...` : input.content);
    const tokenCount = estimateTokens(`${input.title}\n${input.content}`);
    const now = Math.floor(Date.now() / 1000);

    // 1. Generate 1024-dim dense embedding using Workers AI (@cf/baai/bge-m3)
    const embeddingResponse = (await this.env.AI.run(
      this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
      { text: [`${input.title}\n${input.content}`] }
    )) as { data: number[][] };

    const vector = embeddingResponse.data[0];

    // 2. Write memory + optional entity-relation triples in one atomic SQLite transaction
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO memories (
          id, namespace, memory_type, title, content, summary, source_uri,
          token_count, importance, confidence, updated_at, last_accessed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          summary = excluded.summary,
          source_uri = excluded.source_uri,
          token_count = excluded.token_count,
          importance = excluded.importance,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at`,
        id,
        namespace,
        memoryType,
        input.title,
        input.content,
        summary,
        input.sourceUri ?? null,
        tokenCount,
        input.importance ?? 0.6,
        input.confidence ?? 1.0,
        now
      );

      for (const t of input.triples ?? []) {
        this.sql.exec(
          `INSERT INTO entities (entity_id, namespace, entity_type, canonical_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(entity_id) DO UPDATE SET
             canonical_name = excluded.canonical_name,
             updated_at = excluded.updated_at`,
          t.subjectId,
          namespace,
          t.subjectType ?? "concept",
          t.subjectName,
          now
        );

        this.sql.exec(
          `INSERT INTO entities (entity_id, namespace, entity_type, canonical_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(entity_id) DO UPDATE SET
             canonical_name = excluded.canonical_name,
             updated_at = excluded.updated_at`,
          t.objectId,
          namespace,
          t.objectType ?? "concept",
          t.objectName,
          now
        );

        const edgeId = `${t.subjectId}|${t.relation}|${t.objectId}`;
        this.sql.exec(
          `INSERT INTO edges (
            edge_id, namespace, source_entity, relation, target_entity, evidence_memory_id, valid_from
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(edge_id) DO UPDATE SET
            evidence_memory_id = excluded.evidence_memory_id,
            valid_until = NULL`,
          edgeId,
          namespace,
          t.subjectId,
          t.relation,
          t.objectId,
          id,
          now
        );
      }
    });

    // 3. Upsert dense vector into Cloudflare Vectorize
    await this.env.VECTOR_INDEX.upsert([
      {
        id,
        values: vector,
        namespace,
        metadata: {
          namespace,
          title: input.title,
          memory_type: memoryType
        }
      }
    ]);

    return { id, tokenCount, indexedVectors: 1 };
  }

  /**
   * RPC Method 2: Federated 4-Way Hybrid Recall
   *   - Signal 1 (brain_fts): DO SQLite FTS5 BM25
   *   - Signal 2 (brain_vec): Vectorize gemini-brain-bge-m3 (1024-dim) + 1-Hop KG Expansion
   *   - Signal 3 (kb_fts):    D1 archive-knowledge-db kb_fts BM25
   *   - Signal 4 (kb_vec):    Vectorize archive-kb-index (768-dim) hydrated from D1
   */
  async hybridRecall(params: HybridRecallParams): Promise<{
    compiledMarkdown: string;
    tokensUsed: number;
    tokenBudget: number;
    matchedCount: number;
    brainCount: number;
    kbCount: number;
    graphTriplesCount: number;
  }> {
    const namespace = params.namespace || this.env.DEFAULT_NAMESPACE || "global";
    const tokenBudget = params.tokenBudget ?? 1500;
    const halfLifeSeconds = (params.halfLifeDays ?? 30) * 86400;
    const topK = params.topK ?? 15;
    const now = Math.floor(Date.now() / 1000);

    // Step 1: Fan out across Brain (1024-dim + DO SQLite FTS5) AND kb.tsimon.me (768-dim + D1 FTS5) concurrently
    const ftsQuery = buildSafeFts5Query(params.query);

    const brainEmbeddingPromise = this.env.AI.run(
      this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
      { text: [params.query] }
    ) as Promise<{ data: number[][] }>;

    const kbArchivePromise = queryKbArchive(this.env, {
      query: params.query,
      namespace,
      topK
    });

    const lexicalRows =
      ftsQuery !== '""'
        ? this.sql
            .exec<
              MemoryRecord & {
                raw_bm25: number;
                recency_decay: number;
                lexical_rank: number;
              }
            >(LEXICAL_HYBRID_SQL, ftsQuery, namespace, now, halfLifeSeconds, topK)
            .toArray()
        : [];

    const [brainEmbeddingRes, kbArchiveRes] = await Promise.all([
      brainEmbeddingPromise,
      kbArchivePromise
    ]);

    const queryVector1024 = brainEmbeddingRes.data[0];

    // Query Brain Vectorize (1024-dim). When namespace is 'global', search across all Brain namespaces;
    // when a specific namespace is requested, query both that namespace and 'global' concurrently.
    const vectorMatches =
      namespace === "global"
        ? await this.env.VECTOR_INDEX.query(queryVector1024, {
            topK,
            returnMetadata: "none"
          })
        : await (async () => {
            const [nsMatches, globalMatches] = await Promise.all([
              this.env.VECTOR_INDEX.query(queryVector1024, {
                topK,
                namespace,
                returnMetadata: "none"
              }),
              this.env.VECTOR_INDEX.query(queryVector1024, {
                topK: Math.max(5, Math.floor(topK / 2)),
                namespace: "global",
                returnMetadata: "none"
              })
            ]);
            const seen = new Set<string>();
            const combined = [...nsMatches.matches, ...globalMatches.matches]
              .filter((m) => {
                if (seen.has(m.id)) return false;
                seen.add(m.id);
                return true;
              })
              .sort((a, b) => b.score - a.score)
              .slice(0, topK);
            return { matches: combined, count: combined.length };
          })();

    // Step 2: Hydrate vector-only Brain candidates from DO SQLite
    const ftsRecordMap = new Map<string, MemoryRecord>();
    for (const row of lexicalRows) {
      ftsRecordMap.set(row.id, row);
    }

    const missingVecIds = vectorMatches.matches
      .map((m) => m.id)
      .filter((id) => !ftsRecordMap.has(id));

    const hydratedVecMap = new Map<string, MemoryRecord>();
    if (missingVecIds.length > 0) {
      const hydrated = this.sql
        .exec<MemoryRecord>(
          `SELECT
             id, namespace, memory_type, title, content, summary, source_uri,
             token_count, importance, confidence, access_count, updated_at
           FROM memories
           WHERE id IN (SELECT value FROM json_each(?1))
             AND superseded_by IS NULL`,
          JSON.stringify(missingVecIds)
        )
        .toArray();

      for (const row of hydrated) {
        hydratedVecMap.set(row.id, row);
      }
    }

    // Build brainFts and brainVec RankedCandidate lists
    const brainFtsCandidates: RankedCandidate[] = lexicalRows.map((row) => ({
      id: row.id,
      source: "brain_fts",
      origin: "brain.tsimon.me",
      title: `[${row.namespace}] ${row.title}`,
      content: row.content,
      summary: row.summary,
      uri: row.source_uri || `brain://${row.namespace}/${row.id}`,
      namespace: row.namespace,
      rawScore: row.raw_bm25,
      importance: row.importance ?? 0.6,
      updatedAtMs: row.updated_at * 1000
    }));

    const brainVecCandidates: RankedCandidate[] = [];
    for (const match of vectorMatches.matches) {
      const rec = ftsRecordMap.get(match.id) || hydratedVecMap.get(match.id);
      if (!rec) continue;
      brainVecCandidates.push({
        id: rec.id,
        source: "brain_vec",
        origin: "brain.tsimon.me",
        title: `[${rec.namespace}] ${rec.title}`,
        content: rec.content,
        summary: rec.summary,
        uri: rec.source_uri || `brain://${rec.namespace}/${rec.id}`,
        namespace: rec.namespace,
        rawScore: match.score,
        importance: rec.importance ?? 0.6,
        updatedAtMs: rec.updated_at * 1000
      });
    }

    // Step 3: Expand 1-Hop Knowledge Graph Neighbors for the Top Brain Candidates
    const topBrainIds = Array.from(
      new Set([
        ...brainFtsCandidates.slice(0, 6).map((c) => c.id),
        ...brainVecCandidates.slice(0, 6).map((c) => c.id)
      ])
    ).slice(0, 10);

    const queryTerms = params.query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);

    const graphTriples = this.sql
      .exec<GraphTriple>(
        GRAPH_EXPANSION_SQL,
        JSON.stringify(topBrainIds),
        JSON.stringify(queryTerms),
        namespace,
        15
      )
      .toArray();

    // Synaptic reinforcement: increment access_count for recalled Brain memories
    if (topBrainIds.length > 0) {
      this.sql.exec(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?2
         WHERE id IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(topBrainIds),
        now
      );
    }

    // Fetch active ADRs (compact bullet list) for context grounding
    const adrRows = this.sql
      .exec<ActiveDecisionRow>(
        `SELECT decision_id, title, decision, rationale, created_at
         FROM decisions
         WHERE (namespace = ?1 OR namespace = 'global')
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 5`,
        namespace
      )
      .toArray();

    const activeDecisionLines = adrRows.map(
      (r) => `- **[${r.decision_id}] ${r.title}**: ${r.decision}`
    );

    const extraTriples = graphTriples.map((t) => ({
      subject: t.subject_name,
      predicate: t.relation,
      object: t.object_name
    }));

    // Step 4: Execute 4-Way Weighted Reciprocal Rank Fusion (Brain FTS + Brain Vec + KB FTS + KB Vec)
    const fused = fuseBrainAndKb({
      brainFts: brainFtsCandidates,
      brainVec: brainVecCandidates,
      kbFts: kbArchiveRes.ftsResults,
      kbVec: kbArchiveRes.vecResults,
      activeDecisions: activeDecisionLines,
      extraTriples,
      tokenBudget
    });

    return {
      compiledMarkdown: fused.contextBlock,
      tokensUsed: fused.totalTokens,
      tokenBudget: fused.tokenBudget,
      matchedCount: fused.selectedCount,
      brainCount: fused.brainCount,
      kbCount: fused.kbCount,
      graphTriplesCount: fused.graphTriplesCount
    };
  }

  /**
   * RPC Method 3: Log an Immutable Architecture Decision Record (ADR)
   */
  async logDecision(input: {
    namespace?: string;
    title: string;
    decision: string;
    rationale: string;
    supersedesDecisionId?: string;
  }): Promise<{ decisionId: string; status: string }> {
    const decisionId = `adr_${crypto.randomUUID().slice(0, 8)}`;
    const namespace = input.namespace || this.env.DEFAULT_NAMESPACE || "global";
    const now = Math.floor(Date.now() / 1000);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO decisions (decision_id, namespace, title, decision, rationale, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)`,
        decisionId,
        namespace,
        input.title,
        input.decision,
        input.rationale,
        now
      );

      if (input.supersedesDecisionId) {
        this.sql.exec(
          `UPDATE decisions
           SET status = 'superseded', superseded_by = ?1
           WHERE decision_id = ?2`,
          decisionId,
          input.supersedesDecisionId
        );
      }
    });

    return { decisionId, status: "active" };
  }

  /**
   * RPC Method 4: Log an Episodic Session Event for Nocturnal Consolidation
   */
  async logEpisodicEvent(input: {
    sessionId: string;
    clientId: string;
    eventType: "tool_call" | "observation" | "checkpoint" | "error_resolution";
    payload: string;
  }): Promise<{ logId: number; nextConsolidationAt: string }> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.sql
      .exec<{ log_id: number }>(
        `INSERT INTO episodic_logs (session_id, client_id, event_type, payload, consolidated, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)
         RETURNING log_id`,
        input.sessionId,
        input.clientId,
        input.eventType,
        input.payload,
        now
      )
      .one();

    const nextMs = await this.ensureAlarmScheduled();

    return {
      logId: row.log_id,
      nextConsolidationAt: new Date(nextMs).toISOString()
    };
  }

  /**
   * RPC Method 5: Retrieve Active Architecture Decision Records (ADRs) as Markdown
   */
  async getActiveDecisions(namespace = "global"): Promise<string> {
    const rows = this.sql
      .exec<ActiveDecisionRow>(
        `SELECT decision_id, title, decision, rationale, created_at
         FROM decisions
         WHERE (namespace = ?1 OR namespace = 'global')
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 50`,
        namespace
      )
      .toArray();

    if (rows.length === 0) {
      return `# Active Architecture Decision Records (${namespace})\n\n_No active ADRs recorded._`;
    }

    const blocks = rows.map((r) => {
      const dateIso = new Date(r.created_at * 1000).toISOString().slice(0, 10);
      return [
        `## [${r.decision_id}] ${r.title}`,
        `- **Date**: ${dateIso}`,
        `- **Decision**: ${r.decision}`,
        `- **Rationale**: ${r.rationale}`
      ].join("\n");
    });

    return `# Active Architecture Decision Records (${namespace})\n\n${blocks.join("\n\n")}`;
  }

  /**
   * RPC Method 6: Retrieve Namespace Telemetry & Consolidation Status
   */
  async getNamespaceStats(namespace = "global"): Promise<{
    activeMemories: number;
    activeEntities: number;
    activeEdges: number;
    pendingEpisodicLogs: number;
    nextAlarmIso: string | null;
  }> {
    const activeMemories = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE (?1 = 'global' OR namespace = ?1 OR namespace = 'global')
           AND superseded_by IS NULL`,
        namespace
      )
      .one().count;

    const activeEntities = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM entities
         WHERE ?1 = 'global' OR namespace = ?1 OR namespace = 'global'`,
        namespace
      )
      .one().count;

    const activeEdges = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM edges
         WHERE (?1 = 'global' OR namespace = ?1 OR namespace = 'global')
           AND valid_until IS NULL`,
        namespace
      )
      .one().count;

    const pendingEpisodicLogs = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM episodic_logs
         WHERE consolidated = 0`
      )
      .one().count;

    const nextAlarmMs = await this.ctx.storage.getAlarm();

    return {
      activeMemories,
      activeEntities,
      activeEdges,
      pendingEpisodicLogs,
      nextAlarmIso: nextAlarmMs !== null ? new Date(nextAlarmMs).toISOString() : null
    };
  }

  /**
   * Nocturnal "Sleep Cycle" Consolidation Alarm (03:00 AM America/La_Paz / 07:00:00 UTC)
   */
  override async alarm(_alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    try {
      const rows = this.sql
        .exec<EpisodicLogRow>(
          `SELECT log_id, session_id, client_id, event_type, payload, created_at
           FROM episodic_logs
           WHERE consolidated = 0
           ORDER BY created_at ASC
           LIMIT 100`
        )
        .toArray();

      if (rows.length > 0) {
        const formattedLogs = rows
          .map(
            (r) =>
              `[${new Date(r.created_at * 1000).toISOString()}] client=${r.client_id} session=${r.session_id} type=${r.event_type}\n${r.payload}`
          )
          .join("\n\n---\n\n");

        const aiResult = (await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
          {
            messages: [
              {
                role: "system",
                content:
                  "You are the nocturnal memory consolidation engine for a cross-client engineering brain. Synthesize the raw episodic logs into a structured Markdown digest containing: (1) a concise 2-sentence summary, (2) key technical facts and architectural observations, and (3) resolved errors and debugging lessons. Deduplicate redundant events and resolve contradictions."
              },
              {
                role: "user",
                content: formattedLogs
              }
            ],
            max_tokens: 1024,
            temperature: 0.2
          } as never
        )) as unknown as { response?: string };

        const digest =
          aiResult?.response?.trim() ||
          `Consolidated ${rows.length} episodic events across sessions.`;

        await this.rememberFact({
          namespace: "global",
          memoryType: "episodic_summary",
          title: "Daily Consolidated Episodic Digest " + new Date().toISOString().slice(0, 10),
          content: digest,
          importance: 0.75
        });

        const logIds = rows.map((r) => r.log_id);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `UPDATE episodic_logs
             SET consolidated = 1
             WHERE log_id IN (SELECT value FROM json_each(?1))`,
            JSON.stringify(logIds)
          );

          this.sql.exec(
            `UPDATE entities SET pagerank_score = MIN(1.0, 0.15 + 0.85 * (SELECT COUNT(*) FROM edges WHERE target_entity = entities.entity_id AND valid_until IS NULL) * 0.1)`
          );
        });
      }
    } finally {
      await this.ctx.storage.setAlarm(this.getNext0700UtcMs());
    }
  }
}
