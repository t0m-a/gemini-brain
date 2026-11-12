/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\memory-do.ts
 * Purpose: Stateful Durable Object implementing Hybrid Search (SQLite FTS5 + Vectorize + Graph)
 *          and Token-Budgeted Context Compilation.
 */

import { DurableObject } from "cloudflare:workers";
import { SCHEMA_DDL, LEXICAL_HYBRID_SQL, GRAPH_EXPANSION_SQL } from "./schema";

export interface Env {
  BRAIN_DO: DurableObjectNamespace<BrainMemoryDO>;
  VECTOR_INDEX: VectorizeIndex;
  AI: Ai;
  DEFAULT_NAMESPACE: string;
  PRIMARY_DOMAIN: string;
  EMBEDDING_MODEL: string;
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
   * Estimates token count (~4 chars per token heuristic for fast synchronous accounting).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Sanitizes a raw natural-language query into a safe SQLite FTS5 OR expression.
   */
  private buildFts5Query(rawQuery: string): string {
    const tokens = rawQuery
      .replace(/[^\p{L}\p{N}_.\-/]/gu, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);

    if (tokens.length === 0) return '""';
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
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
    const tokenCount = this.estimateTokens(`${input.title}\n${input.content}`);
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
   * RPC Method 2: Hybrid Recall (FTS5 BM25 + Vectorize ANN + RRF Fusion + Graph Expansion + Token Packing)
   */
  async hybridRecall(params: HybridRecallParams): Promise<{
    compiledMarkdown: string;
    tokensUsed: number;
    tokenBudget: number;
    matchedCount: number;
    graphTriplesCount: number;
  }> {
    const namespace = params.namespace || this.env.DEFAULT_NAMESPACE || "global";
    const tokenBudget = params.tokenBudget ?? 1500;
    const halfLifeSeconds = (params.halfLifeDays ?? 30) * 86400;
    const topK = params.topK ?? 20;
    const now = Math.floor(Date.now() / 1000);
    const RRF_K = 60;

    // Step 1: Parallel Semantic Vector Search + Synchronous SQLite FTS5 Lexical Search
    const ftsQuery = this.buildFts5Query(params.query);

    const embeddingPromise = this.env.AI.run(
      this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
      { text: [params.query] }
    ) as Promise<{ data: number[][] }>;

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

    const embeddingRes = await embeddingPromise;
    const queryVector = embeddingRes.data[0];

    const vectorMatches = await this.env.VECTOR_INDEX.query(queryVector, {
      topK,
      namespace,
      returnMetadata: "none"
    });

    // Step 2: Reciprocal Rank Fusion (RRF) across Lexical and Semantic Candidates
    const candidateMap = new Map<
      string,
      {
        record?: MemoryRecord;
        lexicalRank?: number;
        vectorRank?: number;
        vectorScore?: number;
        recencyDecay: number;
      }
    >();

    for (const row of lexicalRows) {
      candidateMap.set(row.id, {
        record: row,
        lexicalRank: row.lexical_rank,
        recencyDecay: row.recency_decay
      });
    }

    vectorMatches.matches.forEach((match, idx) => {
      const existing = candidateMap.get(match.id);
      if (existing) {
        existing.vectorRank = idx + 1;
        existing.vectorScore = match.score;
      } else {
        candidateMap.set(match.id, {
          vectorRank: idx + 1,
          vectorScore: match.score,
          recencyDecay: 1.0
        });
      }
    });

    // Hydrate any vector-only hits from SQLite that were not in the FTS5 result set
    const missingIds = Array.from(candidateMap.entries())
      .filter(([, val]) => !val.record)
      .map(([id]) => id);

    if (missingIds.length > 0) {
      const hydrated = this.sql
        .exec<MemoryRecord & { recency_decay: number }>(
          `SELECT
             id, namespace, memory_type, title, content, summary, source_uri,
             token_count, importance, confidence, access_count, updated_at,
             EXP(-0.693147 * MAX(0, (?2 - updated_at)) / ?3) AS recency_decay
           FROM memories
           WHERE id IN (SELECT value FROM json_each(?1))
             AND superseded_by IS NULL`,
          JSON.stringify(missingIds),
          now,
          halfLifeSeconds
        )
        .toArray();

      for (const row of hydrated) {
        const entry = candidateMap.get(row.id);
        if (entry) {
          entry.record = row;
          entry.recencyDecay = row.recency_decay;
        }
      }
    }

    // Step 3: Compute Composite Context Engineering Score
    // Score(m) = 0.65 * RRF_Norm + 0.20 * RecencyDecay + 0.15 * Importance
    const scoredCandidates = Array.from(candidateMap.values())
      .filter((c): c is Required<typeof c> & { record: MemoryRecord } => Boolean(c.record))
      .map((c) => {
        const rrfLexical = c.lexicalRank ? 1 / (RRF_K + c.lexicalRank) : 0;
        const rrfVector = c.vectorRank ? 1 / (RRF_K + c.vectorRank) : 0;
        const rrfNormalized = (rrfLexical + rrfVector) * (RRF_K / 2);

        const compositeScore =
          0.65 * rrfNormalized +
          0.2 * c.recencyDecay +
          0.15 * (c.record.importance ?? 0.5);

        return {
          ...c.record,
          compositeScore
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore);

    // Step 4: Expand 1-Hop Knowledge Graph Neighbors for the Top Candidates
    const topIds = scoredCandidates.slice(0, 8).map((c) => c.id);
    const queryTerms = params.query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);

    const graphTriples = this.sql
      .exec<GraphTriple>(
        GRAPH_EXPANSION_SQL,
        JSON.stringify(topIds),
        JSON.stringify(queryTerms),
        namespace,
        15
      )
      .toArray();

    // Update access_count and last_accessed_at for recalled memories (synaptic reinforcement)
    if (topIds.length > 0) {
      this.sql.exec(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?2
         WHERE id IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(topIds),
        now
      );
    }

    // Step 5: Deterministic Token-Budgeted Prompt Packer
    // Reserve up to 20% of tokenBudget for Knowledge Graph triples; pack full text for Top 3, summaries for rest
    let tokensUsed = 0;
    const graphBudget = Math.floor(tokenBudget * 0.2);
    const graphLines: string[] = [];

    for (const triple of graphTriples) {
      const line = `- (${triple.subject_name}) --[${triple.relation}]--> (${triple.object_name})`;
      const cost = this.estimateTokens(line);
      if (tokensUsed + cost <= graphBudget) {
        graphLines.push(line);
        tokensUsed += cost;
      }
    }

    const fullBlocks: string[] = [];
    const summaryBlocks: string[] = [];

    scoredCandidates.forEach((mem, idx) => {
      if (idx < 3) {
        const block = `### [${mem.namespace}] ${mem.title} (score: ${mem.compositeScore.toFixed(3)})\n${mem.content}`;
        const cost = this.estimateTokens(block);
        if (tokensUsed + cost <= tokenBudget) {
          fullBlocks.push(block);
          tokensUsed += cost;
          return;
        }
      }

      // Fallback or rank >= 4: pack compressed summary
      const summaryText = mem.summary || mem.content.slice(0, 220);
      const condensed = `- **${mem.title}** (${mem.source_uri ?? mem.memory_type}): ${summaryText}`;
      const summaryCost = this.estimateTokens(condensed);
      if (tokensUsed + summaryCost <= tokenBudget) {
        summaryBlocks.push(condensed);
        tokensUsed += summaryCost;
      }
    });

    const sections: string[] = [
      `<brain_context namespace="${namespace}" tokens_used="${tokensUsed}" token_budget="${tokenBudget}">`
    ];

    if (fullBlocks.length > 0) {
      sections.push(`## Primary Recalled Memories\n${fullBlocks.join("\n\n")}`);
    }
    if (summaryBlocks.length > 0) {
      sections.push(`## Secondary Condensed Context\n${summaryBlocks.join("\n")}`);
    }
    if (graphLines.length > 0) {
      sections.push(`## Connected Knowledge Graph Triples\n${graphLines.join("\n")}`);
    }
    sections.push(`</brain_context>`);

    return {
      compiledMarkdown: sections.join("\n\n"),
      tokensUsed,
      tokenBudget,
      matchedCount: fullBlocks.length + summaryBlocks.length,
      graphTriplesCount: graphLines.length
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
         WHERE (namespace = ?1 OR namespace = 'global')
           AND superseded_by IS NULL`,
        namespace
      )
      .one().count;

    const activeEntities = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM entities
         WHERE namespace = ?1 OR namespace = 'global'`,
        namespace
      )
      .one().count;

    const activeEdges = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM edges
         WHERE (namespace = ?1 OR namespace = 'global')
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