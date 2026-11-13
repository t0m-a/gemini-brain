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

export type MutationAuditRow = {
  mutation_id: number;
  memory_id: string;
  namespace: string;
  memory_type: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "CONSOLIDATE" | "ROLLBACK";
  client_id: string;
  old_title: string | null;
  old_content: string | null;
  old_summary: string | null;
  old_importance: number | null;
  new_title: string | null;
  new_content: string | null;
  new_summary: string | null;
  new_importance: number | null;
  source_uri: string | null;
  rolled_back: number;
  created_at: number;
};

export type ConsolidationRunRow = {
  run_id: number;
  digest_memory_id: string | null;
  events_count: number;
  clients_json: string;
  log_ids_json: string;
  digest_title: string | null;
  digest_content: string | null;
  trigger_source: string;
  created_at: number;
};

export interface OvernightDiffParams {
  hours?: number;
  clientId?: string;
  namespace?: string;
  memoryId?: string;
  operation?: "ALL" | "INSERT" | "UPDATE" | "DELETE" | "CONSOLIDATE" | "ROLLBACK";
  limit?: number;
}

export interface ConsolidationLogsParams {
  hours?: number;
  clientId?: string;
  pendingOnly?: boolean;
  limit?: number;
}

export interface RollbackMutationParams {
  mutationId?: number;
  memoryId?: string;
  clientId?: string;
}

export interface ReindexMemoriesParams {
  memoryIds?: string[];
  namespace?: string;
  hours?: number;
  rebuildFts?: boolean;
  limit?: number;
}

function inferClientId(
  explicitClientId?: string,
  sourceUri?: string | null,
  memoryType?: string
): string {
  if (explicitClientId && explicitClientId.trim()) {
    return explicitClientId.trim();
  }
  if (memoryType === "episodic_summary") {
    return "nocturnal-consolidator";
  }
  const uri = (sourceUri || "").toLowerCase();
  if (uri.startsWith("rpi5://")) return "rpi5-debian13-daemon";
  if (uri.startsWith("qdrant://")) return "rpi5-qdrant-federator";
  if (uri.includes("takeout")) return "takeout-ingestor";
  if (uri.includes("test_brain_mcp")) return "test-verifier";
  return "mcp-client";
}

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
    clientId?: string;
    importance?: number;
    confidence?: number;
    createdAt?: number;
    triples?: Array<{
      subjectId: string;
      subjectName: string;
      subjectType?: string;
      relation: string;
      objectId: string;
      objectName: string;
      objectType?: string;
    }>;
  }): Promise<{ id: string; tokenCount: number; indexedVectors: number; mutationId?: number }> {
    const res = await this.rememberFactsBatch([input]);
    return {
      id: res.ids[0] || input.id || "",
      tokenCount: res.totalTokens,
      indexedVectors: res.indexedVectors,
      mutationId: res.mutationIds?.[0]
    };
  }

  /**
   * RPC Method 1B: Batch-Upsert Semantic Memories + Knowledge Graph Triples + 1024-dim Vector Embeddings
   */
  async rememberFactsBatch(
    inputs: Array<{
      id?: string;
      namespace?: string;
      memoryType?: "semantic" | "procedural" | "episodic_summary";
      title: string;
      content: string;
      summary?: string;
      sourceUri?: string;
      clientId?: string;
      importance?: number;
      confidence?: number;
      createdAt?: number;
      triples?: Array<{
        subjectId: string;
        subjectName: string;
        subjectType?: string;
        relation: string;
        objectId: string;
        objectName: string;
        objectType?: string;
      }>;
    }>
  ): Promise<{ ids: string[]; totalTokens: number; indexedVectors: number; mutationIds: number[] }> {
    if (!inputs || inputs.length === 0) {
      return { ids: [], totalTokens: 0, indexedVectors: 0, mutationIds: [] };
    }

    const now = Math.floor(Date.now() / 1000);
    const prepared = inputs.map((input) => {
      const namespace = input.namespace || this.env.DEFAULT_NAMESPACE || "global";
      const memoryType = input.memoryType || "semantic";
      const id = (input.id || crypto.randomUUID()).slice(0, 64);
      const summary =
        input.summary ||
        (input.content.length > 280 ? `${input.content.slice(0, 277)}...` : input.content);
      const tokenCount = estimateTokens(`${input.title}\n${input.content}`);
      const eventTs =
        typeof input.createdAt === "number" && input.createdAt > 0
          ? Math.floor(input.createdAt)
          : now;
      const clientId = inferClientId(input.clientId, input.sourceUri, memoryType);
      return {
        ...input,
        id,
        namespace,
        memoryType,
        summary,
        tokenCount,
        eventTs,
        clientId
      };
    });

    // 1. Generate 1024-dim dense embeddings in a single Workers AI batch call (@cf/baai/bge-m3)
    const embeddingResponse = (await this.env.AI.run(
      this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
      {
        text: prepared.map((p) => `${p.title}\n${p.content.slice(0, 3500)}`)
      }
    )) as { data: number[][] };

    const mutationIds: number[] = [];

    // 2. Write all memories + mutation audit trail + entity-relation triples in one atomic SQLite transaction
    this.ctx.storage.transactionSync(() => {
      for (const p of prepared) {
        const existingRows = this.sql
          .exec<{
            id: string;
            title: string;
            content: string;
            summary: string | null;
            importance: number;
          }>(
            `SELECT id, title, content, summary, importance
             FROM memories
             WHERE id = ?1`,
            p.id
          )
          .toArray();
        const existing = existingRows[0];

        this.sql.exec(
          `INSERT INTO memories (
            id, namespace, memory_type, title, content, summary, source_uri,
            token_count, importance, confidence, created_at, updated_at, last_accessed_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            summary = excluded.summary,
            source_uri = excluded.source_uri,
            token_count = excluded.token_count,
            importance = excluded.importance,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at`,
          p.id,
          p.namespace,
          p.memoryType,
          p.title,
          p.content,
          p.summary,
          p.sourceUri ?? null,
          p.tokenCount,
          p.importance ?? 0.6,
          p.confidence ?? 1.0,
          p.eventTs,
          now
        );

        // Record before/after snapshot in memory_mutations if newly inserted or modified
        if (!existing) {
          const op = p.memoryType === "episodic_summary" ? "CONSOLIDATE" : "INSERT";
          const mutRow = this.sql
            .exec<{ mutation_id: number }>(
              `INSERT INTO memory_mutations (
                memory_id, namespace, memory_type, operation, client_id,
                old_title, old_content, old_summary, old_importance,
                new_title, new_content, new_summary, new_importance,
                source_uri, rolled_back, created_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6, ?7, ?8, ?9, ?10, 0, ?11)
              RETURNING mutation_id`,
              p.id,
              p.namespace,
              p.memoryType,
              op,
              p.clientId,
              p.title,
              p.content,
              p.summary,
              p.importance ?? 0.6,
              p.sourceUri ?? null,
              now
            )
            .one();
          mutationIds.push(mutRow.mutation_id);
        } else if (existing.title !== p.title || existing.content !== p.content) {
          const mutRow = this.sql
            .exec<{ mutation_id: number }>(
              `INSERT INTO memory_mutations (
                memory_id, namespace, memory_type, operation, client_id,
                old_title, old_content, old_summary, old_importance,
                new_title, new_content, new_summary, new_importance,
                source_uri, rolled_back, created_at
              ) VALUES (?1, ?2, ?3, 'UPDATE', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)
              RETURNING mutation_id`,
              p.id,
              p.namespace,
              p.memoryType,
              p.clientId,
              existing.title,
              existing.content,
              existing.summary,
              existing.importance,
              p.title,
              p.content,
              p.summary,
              p.importance ?? 0.6,
              p.sourceUri ?? null,
              now
            )
            .one();
          mutationIds.push(mutRow.mutation_id);
        }

        for (const t of p.triples ?? []) {
          this.sql.exec(
            `INSERT INTO entities (entity_id, namespace, entity_type, canonical_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(entity_id) DO UPDATE SET
               canonical_name = excluded.canonical_name,
               updated_at = excluded.updated_at`,
            t.subjectId,
            p.namespace,
            t.subjectType ?? "concept",
            t.subjectName,
            p.eventTs
          );

          this.sql.exec(
            `INSERT INTO entities (entity_id, namespace, entity_type, canonical_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(entity_id) DO UPDATE SET
               canonical_name = excluded.canonical_name,
               updated_at = excluded.updated_at`,
            t.objectId,
            p.namespace,
            t.objectType ?? "concept",
            t.objectName,
            p.eventTs
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
            p.namespace,
            t.subjectId,
            t.relation,
            t.objectId,
            p.id,
            p.eventTs
          );
        }
      }
    });

    // 3. Upsert dense vectors into Cloudflare Vectorize
    const vectors: VectorizeVector[] = [];
    prepared.forEach((p, idx) => {
      const vec = embeddingResponse.data?.[idx];
      if (vec) {
        vectors.push({
          id: p.id,
          values: vec,
          namespace: p.namespace,
          metadata: {
            namespace: p.namespace,
            title: p.title,
            memory_type: p.memoryType
          }
        });
      }
    });

    if (vectors.length > 0) {
      await this.env.VECTOR_INDEX.upsert(vectors);
    }

    const totalTokens = prepared.reduce((acc, p) => acc + p.tokenCount, 0);
    return {
      ids: prepared.map((p) => p.id),
      totalTokens,
      indexedVectors: vectors.length,
      mutationIds
    };
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
   * RPC Method 7: Query Overnight Mutations, Before/After Diffs & Morning Session Hydration Context
   */
  async getOvernightDiff(params: OvernightDiffParams = {}): Promise<{
    windowHours: number;
    sinceUnix: number;
    sinceIso: string;
    summary: {
      totalMutations: number;
      byOperation: Record<string, number>;
      byClient: Record<string, number>;
      byNamespace: Record<string, number>;
      decisionsAdded: number;
      episodicEventsLogged: number;
      episodicPending: number;
      nextAlarmIso: string | null;
    };
    mutations: MutationAuditRow[];
    decisions: Array<ActiveDecisionRow & { namespace: string; status: string }>;
    consolidations: ConsolidationRunRow[];
    hydrationMarkdown: string;
  }> {
    const windowHours = Math.max(1, Math.min(720, params.hours ?? 12));
    const now = Math.floor(Date.now() / 1000);
    const sinceUnix = now - Math.floor(windowHours * 3600);
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const opFilter = (params.operation || "ALL").toUpperCase();
    const clientFilter = params.clientId?.trim() || "";
    const nsFilter = params.namespace?.trim() || "";
    const memFilter = params.memoryId?.trim() || "";

    // 1. Fetch explicit audit mutations in the window
    const rawMutations = this.sql
      .exec<MutationAuditRow>(
        `SELECT
           mutation_id, memory_id, namespace, memory_type, operation, client_id,
           old_title, old_content, old_summary, old_importance,
           new_title, new_content, new_summary, new_importance,
           source_uri, rolled_back, created_at
         FROM memory_mutations
         WHERE (?1 = '' OR memory_id = ?1)
           AND (?1 != '' OR created_at >= ?2)
           AND (?3 = 'ALL' OR operation = ?3)
           AND (?4 = '' OR client_id = ?4)
           AND (?5 = '' OR namespace = ?5)
         ORDER BY created_at DESC, mutation_id DESC
         LIMIT ?6`,
        memFilter,
        sinceUnix,
        opFilter,
        clientFilter,
        nsFilter,
        limit
      )
      .toArray();

    // 2. Include fallback virtual entries for memories updated in the window prior to audit table creation
    const auditedIds = new Set(rawMutations.map((m) => m.memory_id));
    if (rawMutations.length < limit) {
      const fallbackRows = this.sql
        .exec<{
          id: string;
          namespace: string;
          memory_type: string;
          title: string;
          content: string;
          summary: string | null;
          source_uri: string | null;
          importance: number;
          created_at: number;
          updated_at: number;
        }>(
          `SELECT
             id, namespace, memory_type, title, content, summary, source_uri,
             importance, created_at, updated_at
           FROM memories
           WHERE (?1 = '' OR id = ?1)
             AND (?1 != '' OR updated_at >= ?2)
             AND (?3 = '' OR namespace = ?3)
             AND superseded_by IS NULL
           ORDER BY updated_at DESC
           LIMIT ?4`,
          memFilter,
          sinceUnix,
          nsFilter,
          limit
        )
        .toArray();

      for (const r of fallbackRows) {
        if (auditedIds.has(r.id)) continue;
        const inferredClient = inferClientId(undefined, r.source_uri, r.memory_type);
        if (clientFilter && inferredClient !== clientFilter) continue;
        const inferredOp: MutationAuditRow["operation"] =
          r.memory_type === "episodic_summary"
            ? "CONSOLIDATE"
            : r.updated_at > r.created_at
              ? "UPDATE"
              : "INSERT";
        if (opFilter !== "ALL" && inferredOp !== opFilter) continue;

        rawMutations.push({
          mutation_id: 0,
          memory_id: r.id,
          namespace: r.namespace,
          memory_type: r.memory_type,
          operation: inferredOp,
          client_id: inferredClient,
          old_title: null,
          old_content: null,
          old_summary: null,
          old_importance: null,
          new_title: r.title,
          new_content: r.content,
          new_summary: r.summary,
          new_importance: r.importance,
          source_uri: r.source_uri,
          rolled_back: 0,
          created_at: r.updated_at
        });
        if (rawMutations.length >= limit) break;
      }
    }

    rawMutations.sort((a, b) => b.created_at - a.created_at || b.mutation_id - a.mutation_id);

    // 3. Aggregate summary counts
    const byOperation: Record<string, number> = {};
    const byClient: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};
    for (const m of rawMutations) {
      byOperation[m.operation] = (byOperation[m.operation] || 0) + 1;
      byClient[m.client_id] = (byClient[m.client_id] || 0) + 1;
      byNamespace[m.namespace] = (byNamespace[m.namespace] || 0) + 1;
    }

    // 4. Fetch decisions & consolidations in the window
    const decisions = this.sql
      .exec<ActiveDecisionRow & { namespace: string; status: string }>(
        `SELECT decision_id, namespace, title, decision, rationale, status, created_at
         FROM decisions
         WHERE created_at >= ?1
           AND (?2 = '' OR namespace = ?2)
         ORDER BY created_at DESC
         LIMIT 20`,
        sinceUnix,
        nsFilter
      )
      .toArray();

    const consolidations = this.sql
      .exec<ConsolidationRunRow>(
        `SELECT
           run_id, digest_memory_id, events_count, clients_json, log_ids_json,
           digest_title, digest_content, trigger_source, created_at
         FROM consolidation_runs
         WHERE created_at >= ?1
         ORDER BY created_at DESC
         LIMIT 10`,
        sinceUnix
      )
      .toArray();

    const episodicLoggedCount = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM episodic_logs WHERE created_at >= ?1`,
        sinceUnix
      )
      .one().count;

    const episodicPendingCount = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM episodic_logs WHERE consolidated = 0`
      )
      .one().count;

    const nextAlarmMs = await this.ctx.storage.getAlarm();
    const nextAlarmIso = nextAlarmMs !== null ? new Date(nextAlarmMs).toISOString() : null;
    const sinceIso = new Date(sinceUnix * 1000).toISOString();

    // 5. Build token-efficient Morning Hydration Markdown Block for Gemini / VS Code / Antigravity
    const mdLines: string[] = [
      `<overnight_brain_diff window_hours="${windowHours}" since="${sinceIso}" total_mutations="${rawMutations.length}" decisions_added="${decisions.length}" episodic_pending="${episodicPendingCount}">`,
      `### Overnight Brain State Summary (Last ${windowHours}h)`,
      `- **Window**: \`${sinceIso}\` -> \`${new Date(now * 1000).toISOString()}\``,
      `- **Mutations**: ${rawMutations.length} (${Object.entries(byOperation)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none"})`,
      `- **By Client**: ${Object.entries(byClient)
        .map(([k, v]) => `\`${k}\` (${v})`)
        .join(", ") || "none"}`,
      `- **By Namespace**: ${Object.entries(byNamespace)
        .map(([k, v]) => `\`${k}\` (${v})`)
        .join(", ") || "none"}`,
      `- **Episodic Buffer**: ${episodicLoggedCount} logged in window | ${episodicPendingCount} pending consolidation | Next 03:00 AM alarm: \`${nextAlarmIso || "unscheduled"}\``
    ];

    if (consolidations.length > 0) {
      mdLines.push(`\n### Nocturnal Consolidation Digests`);
      for (const c of consolidations.slice(0, 3)) {
        const ts = new Date(c.created_at * 1000).toISOString();
        mdLines.push(
          `#### [Run #${c.run_id}] ${c.digest_title || "Nocturnal Digest"} (${ts} | ${c.events_count} events | via ${c.trigger_source})`,
          c.digest_content || "_No digest text_"
        );
      }
    }

    if (decisions.length > 0) {
      mdLines.push(`\n### New Architectural Decisions (ADRs)`);
      for (const d of decisions) {
        mdLines.push(`- **[${d.decision_id}] (${d.namespace}) ${d.title}**: ${d.decision}`);
      }
    }

    if (rawMutations.length > 0) {
      mdLines.push(`\n### Recent Memory Mutations (Top ${Math.min(15, rawMutations.length)})`);
      for (const m of rawMutations.slice(0, 15)) {
        const ts = new Date(m.created_at * 1000).toISOString();
        const title = m.new_title || m.old_title || m.memory_id;
        const rbTag = m.rolled_back ? " [ROLLED BACK]" : "";
        const mutBadge = m.mutation_id > 0 ? `#${m.mutation_id}` : "pre-audit";
        const snippet = (m.new_summary || m.new_content || m.old_content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        mdLines.push(
          `- **[${m.operation} ${mutBadge}]${rbTag}** \`[${m.namespace}]\` **${title}** (id: \`${m.memory_id}\`, client: \`${m.client_id}\`, at: \`${ts}\`)\n  ${snippet}`
        );
      }
    }

    mdLines.push(`</overnight_brain_diff>`);

    return {
      windowHours,
      sinceUnix,
      sinceIso,
      summary: {
        totalMutations: rawMutations.length,
        byOperation,
        byClient,
        byNamespace,
        decisionsAdded: decisions.length,
        episodicEventsLogged: episodicLoggedCount,
        episodicPending: episodicPendingCount,
        nextAlarmIso
      },
      mutations: rawMutations,
      decisions,
      consolidations,
      hydrationMarkdown: mdLines.join("\n")
    };
  }

  /**
   * RPC Method 8: View Nocturnal Consolidation Digests & Raw Episodic Session Logs
   */
  async getConsolidationLogs(params: ConsolidationLogsParams = {}): Promise<{
    windowHours: number;
    stats: Awaited<ReturnType<BrainMemoryDO["getNamespaceStats"]>>;
    runs: ConsolidationRunRow[];
    episodicLogs: Array<EpisodicLogRow & { consolidated: number }>;
  }> {
    const windowHours = Math.max(1, Math.min(720, params.hours ?? 24));
    const sinceUnix = Math.floor(Date.now() / 1000) - Math.floor(windowHours * 3600);
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const clientFilter = params.clientId?.trim() || "";
    const pendingOnly = Boolean(params.pendingOnly);

    const stats = await this.getNamespaceStats("global");

    const runs = this.sql
      .exec<ConsolidationRunRow>(
        `SELECT
           run_id, digest_memory_id, events_count, clients_json, log_ids_json,
           digest_title, digest_content, trigger_source, created_at
         FROM consolidation_runs
         WHERE created_at >= ?1
         ORDER BY created_at DESC
         LIMIT 20`,
        sinceUnix
      )
      .toArray();

    // Also include any episodic_summary memories not yet represented in consolidation_runs
    const knownDigestIds = new Set(
      runs.map((r) => r.digest_memory_id).filter((id): id is string => Boolean(id))
    );
    const summaryMemories = this.sql
      .exec<{
        id: string;
        title: string;
        content: string;
        updated_at: number;
      }>(
        `SELECT id, title, content, updated_at
         FROM memories
         WHERE memory_type = 'episodic_summary'
           AND updated_at >= ?1
           AND superseded_by IS NULL
         ORDER BY updated_at DESC
         LIMIT 10`,
        sinceUnix
      )
      .toArray();

    for (const sm of summaryMemories) {
      if (!knownDigestIds.has(sm.id)) {
        runs.push({
          run_id: 0,
          digest_memory_id: sm.id,
          events_count: 0,
          clients_json: '["episodic-summary"]',
          log_ids_json: "[]",
          digest_title: sm.title,
          digest_content: sm.content,
          trigger_source: "alarm_0300",
          created_at: sm.updated_at
        });
      }
    }

    const episodicLogs = this.sql
      .exec<EpisodicLogRow & { consolidated: number }>(
        `SELECT log_id, session_id, client_id, event_type, payload, consolidated, created_at
         FROM episodic_logs
         WHERE created_at >= ?1
           AND (?2 = '' OR client_id = ?2)
           AND (?3 = 0 OR consolidated = 0)
         ORDER BY created_at DESC, log_id DESC
         LIMIT ?4`,
        sinceUnix,
        clientFilter,
        pendingOnly ? 1 : 0,
        limit
      )
      .toArray();

    return {
      windowHours,
      stats,
      runs,
      episodicLogs
    };
  }

  /**
   * RPC Method 9: Execute Nocturnal Consolidation Immediately (or via 03:00 AM Alarm)
   */
  async runConsolidationNow(triggerSource = "manual_cli"): Promise<{
    consolidatedCount: number;
    runId: number | null;
    digestMemoryId: string | null;
    digestTitle: string | null;
    digestContent: string | null;
    nextAlarmIso: string | null;
  }> {
    const rows = this.sql
      .exec<EpisodicLogRow>(
        `SELECT log_id, session_id, client_id, event_type, payload, created_at
         FROM episodic_logs
         WHERE consolidated = 0
         ORDER BY created_at ASC
         LIMIT 100`
      )
      .toArray();

    if (rows.length === 0) {
      const nextMs = await this.ensureAlarmScheduled();
      return {
        consolidatedCount: 0,
        runId: null,
        digestMemoryId: null,
        digestTitle: null,
        digestContent: null,
        nextAlarmIso: new Date(nextMs).toISOString()
      };
    }

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
    const digestTitle =
      "Daily Consolidated Episodic Digest " + new Date().toISOString().slice(0, 10);

    const saved = await this.rememberFact({
      namespace: "global",
      memoryType: "episodic_summary",
      title: digestTitle,
      content: digest,
      clientId: triggerSource === "alarm_0300" ? "nocturnal-consolidator" : "manual-consolidator",
      importance: 0.75
    });

    const logIds = rows.map((r) => r.log_id);
    const uniqueClients = Array.from(new Set(rows.map((r) => r.client_id)));
    const now = Math.floor(Date.now() / 1000);
    let runId: number | null = null;

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

      const runRow = this.sql
        .exec<{ run_id: number }>(
          `INSERT INTO consolidation_runs (
             digest_memory_id, events_count, clients_json, log_ids_json,
             digest_title, digest_content, trigger_source, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           RETURNING run_id`,
          saved.id,
          rows.length,
          JSON.stringify(uniqueClients),
          JSON.stringify(logIds),
          digestTitle,
          digest,
          triggerSource,
          now
        )
        .one();
      runId = runRow.run_id;
    });

    const nextMs = await this.ensureAlarmScheduled();
    return {
      consolidatedCount: rows.length,
      runId,
      digestMemoryId: saved.id,
      digestTitle,
      digestContent: digest,
      nextAlarmIso: new Date(nextMs).toISOString()
    };
  }

  /**
   * RPC Method 10: Atomic Rollback of a Memory Mutation + Vectorize Re-Sync
   */
  async rollbackMutation(params: RollbackMutationParams): Promise<{
    ok: boolean;
    action?: "RESTORED_PREVIOUS_VERSION" | "DELETED_INSERTED_FACT";
    rolledBackMutationId?: number;
    rollbackAuditId?: number;
    memoryId?: string;
    namespace?: string;
    title?: string | null;
    vectorSynced?: boolean;
    error?: string;
  }> {
    const mutId = params.mutationId && params.mutationId > 0 ? params.mutationId : null;
    const memId = params.memoryId?.trim() || "";
    const clientId = params.clientId?.trim() || "cli-rollback";

    if (!mutId && !memId) {
      return { ok: false, error: "Provide either mutationId (> 0) or memoryId to roll back." };
    }

    const candidates = mutId
      ? this.sql
          .exec<MutationAuditRow>(
            `SELECT
               mutation_id, memory_id, namespace, memory_type, operation, client_id,
               old_title, old_content, old_summary, old_importance,
               new_title, new_content, new_summary, new_importance,
               source_uri, rolled_back, created_at
             FROM memory_mutations
             WHERE mutation_id = ?1`,
            mutId
          )
          .toArray()
      : this.sql
          .exec<MutationAuditRow>(
            `SELECT
               mutation_id, memory_id, namespace, memory_type, operation, client_id,
               old_title, old_content, old_summary, old_importance,
               new_title, new_content, new_summary, new_importance,
               source_uri, rolled_back, created_at
             FROM memory_mutations
             WHERE memory_id = ?1
               AND rolled_back = 0
               AND operation IN ('UPDATE', 'INSERT', 'CONSOLIDATE')
             ORDER BY mutation_id DESC
             LIMIT 1`,
            memId
          )
          .toArray();

    const target = candidates[0];
    if (!target) {
      return {
        ok: false,
        error: `No eligible mutation found for ${mutId ? `mutation_id=${mutId}` : `memory_id=${memId}`}.`
      };
    }

    if (target.rolled_back === 1) {
      return {
        ok: false,
        error: `Mutation #${target.mutation_id} (${target.memory_id}) has already been rolled back.`
      };
    }

    const now = Math.floor(Date.now() / 1000);
    let rollbackAuditId = 0;

    // Case A: Mutation had a prior version (UPDATE) -> restore old_title + old_content
    if (target.old_content !== null) {
      const restoredTitle = target.old_title || target.new_title || target.memory_id;
      const restoredContent = target.old_content;
      const restoredSummary =
        target.old_summary ||
        (restoredContent.length > 280 ? `${restoredContent.slice(0, 277)}...` : restoredContent);
      const restoredImportance = target.old_importance ?? 0.6;
      const tokenCount = estimateTokens(`${restoredTitle}\n${restoredContent}`);

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE memories
           SET title = ?1,
               content = ?2,
               summary = ?3,
               importance = ?4,
               token_count = ?5,
               updated_at = ?6
           WHERE id = ?7`,
          restoredTitle,
          restoredContent,
          restoredSummary,
          restoredImportance,
          tokenCount,
          now,
          target.memory_id
        );

        this.sql.exec(
          `UPDATE memory_mutations SET rolled_back = 1 WHERE mutation_id = ?1`,
          target.mutation_id
        );

        const rbRow = this.sql
          .exec<{ mutation_id: number }>(
            `INSERT INTO memory_mutations (
               memory_id, namespace, memory_type, operation, client_id,
               old_title, old_content, old_summary, old_importance,
               new_title, new_content, new_summary, new_importance,
               source_uri, rolled_back, created_at
             ) VALUES (?1, ?2, ?3, 'ROLLBACK', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)
             RETURNING mutation_id`,
            target.memory_id,
            target.namespace,
            target.memory_type,
            clientId,
            target.new_title,
            target.new_content,
            target.new_summary,
            target.new_importance,
            restoredTitle,
            restoredContent,
            restoredSummary,
            restoredImportance,
            target.source_uri,
            now
          )
          .one();
        rollbackAuditId = rbRow.mutation_id;
      });

      // Re-compute 1024-dim embedding for the restored text and upsert into Vectorize
      const embRes = (await this.env.AI.run(
        this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
        { text: [`${restoredTitle}\n${restoredContent.slice(0, 3500)}`] }
      )) as { data: number[][] };

      const vec = embRes.data?.[0];
      if (vec) {
        await this.env.VECTOR_INDEX.upsert([
          {
            id: target.memory_id,
            values: vec,
            namespace: target.namespace,
            metadata: {
              namespace: target.namespace,
              title: restoredTitle,
              memory_type: target.memory_type
            }
          }
        ]);
      }

      return {
        ok: true,
        action: "RESTORED_PREVIOUS_VERSION",
        rolledBackMutationId: target.mutation_id,
        rollbackAuditId,
        memoryId: target.memory_id,
        namespace: target.namespace,
        title: restoredTitle,
        vectorSynced: Boolean(vec)
      };
    }

    // Case B: Mutation was an INSERT/CONSOLIDATE with no previous version -> delete memory & vector
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM memories WHERE id = ?1`, target.memory_id);
      this.sql.exec(
        `UPDATE memory_mutations SET rolled_back = 1 WHERE mutation_id = ?1`,
        target.mutation_id
      );

      const rbRow = this.sql
        .exec<{ mutation_id: number }>(
          `INSERT INTO memory_mutations (
             memory_id, namespace, memory_type, operation, client_id,
             old_title, old_content, old_summary, old_importance,
             new_title, new_content, new_summary, new_importance,
             source_uri, rolled_back, created_at
           ) VALUES (?1, ?2, ?3, 'ROLLBACK', ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, ?9, 0, ?10)
           RETURNING mutation_id`,
          target.memory_id,
          target.namespace,
          target.memory_type,
          clientId,
          target.new_title,
          target.new_content,
          target.new_summary,
          target.new_importance,
          target.source_uri,
          now
        )
        .one();
      rollbackAuditId = rbRow.mutation_id;
    });

    await this.env.VECTOR_INDEX.deleteByIds([target.memory_id]);

    return {
      ok: true,
      action: "DELETED_INSERTED_FACT",
      rolledBackMutationId: target.mutation_id,
      rollbackAuditId,
      memoryId: target.memory_id,
      namespace: target.namespace,
      title: target.new_title,
      vectorSynced: true
    };
  }

  /**
   * RPC Method 11: Re-Index SQLite FTS5 & Re-Embed 1024-dim Vectors in Vectorize
   */
  async reindexMemories(params: ReindexMemoriesParams = {}): Promise<{
    ok: boolean;
    ftsRebuilt: boolean;
    reindexedVectors: number;
    memoryIds: string[];
  }> {
    const rebuildFts = params.rebuildFts !== false;
    const limit = Math.max(1, Math.min(100, params.limit ?? 30));
    const nsFilter = params.namespace?.trim() || "";
    const hours = Math.max(1, Math.min(720, params.hours ?? 24));
    const sinceUnix = Math.floor(Date.now() / 1000) - Math.floor(hours * 3600);

    if (rebuildFts) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
      });
    }

    const rows =
      params.memoryIds && params.memoryIds.length > 0
        ? this.sql
            .exec<{
              id: string;
              namespace: string;
              memory_type: string;
              title: string;
              content: string;
            }>(
              `SELECT id, namespace, memory_type, title, content
               FROM memories
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND superseded_by IS NULL`,
              JSON.stringify(params.memoryIds)
            )
            .toArray()
        : this.sql
            .exec<{
              id: string;
              namespace: string;
              memory_type: string;
              title: string;
              content: string;
            }>(
              `SELECT id, namespace, memory_type, title, content
               FROM memories
               WHERE updated_at >= ?1
                 AND (?2 = '' OR namespace = ?2)
                 AND superseded_by IS NULL
               ORDER BY updated_at DESC
               LIMIT ?3`,
              sinceUnix,
              nsFilter,
              limit
            )
            .toArray();

    if (rows.length === 0) {
      return {
        ok: true,
        ftsRebuilt: rebuildFts,
        reindexedVectors: 0,
        memoryIds: []
      };
    }

    const embRes = (await this.env.AI.run(
      this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
      {
        text: rows.map((r) => `${r.title}\n${r.content.slice(0, 3500)}`)
      }
    )) as { data: number[][] };

    const vectors: VectorizeVector[] = [];
    rows.forEach((r, idx) => {
      const vec = embRes.data?.[idx];
      if (vec) {
        vectors.push({
          id: r.id,
          values: vec,
          namespace: r.namespace,
          metadata: {
            namespace: r.namespace,
            title: r.title,
            memory_type: r.memory_type
          }
        });
      }
    });

    if (vectors.length > 0) {
      await this.env.VECTOR_INDEX.upsert(vectors);
    }

    return {
      ok: true,
      ftsRebuilt: rebuildFts,
      reindexedVectors: vectors.length,
      memoryIds: rows.map((r) => r.id)
    };
  }

  /**
   * Nocturnal "Sleep Cycle" Consolidation Alarm (03:00 AM America/La_Paz / 07:00:00 UTC)
   */
  override async alarm(_alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    try {
      await this.runConsolidationNow("alarm_0300");
    } finally {
      await this.ctx.storage.setAlarm(this.getNext0700UtcMs());
    }
  }
}
