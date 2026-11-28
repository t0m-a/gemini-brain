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
  parseIsoToMs,
  queryKbArchive,
  type RankedCandidate,
  type ScoreExplanation
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
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_TEAM_DOMAIN?: string;
  OAUTH_ALLOWED_REDIRECT_ORIGINS?: string;
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
  explain?: boolean;
}

export interface ForgetMemoryParams {
  memoryId: string;
  mode?: "soft_retire" | "hard_delete";
  reason?: string;
  retireLinkedEdges?: boolean;
  clientId?: string;
}

export type OutcomeStatus = "success" | "partial" | "failure" | "abandoned";

export type OutcomeRow = {
  outcome_id: string;
  session_id: string;
  namespace: string;
  task_type: string;
  query: string;
  status: OutcomeStatus;
  result_summary: string;
  failed_attempts: string | null;
  cited_memory_ids_json: string;
  verifier: string | null;
  evidence_uri: string | null;
  operator_feedback: number | null;
  client_id: string;
  created_at: number;
};

export interface RecordOutcomeParams {
  outcomeId?: string;
  sessionId: string;
  namespace?: string;
  taskType: string;
  query: string;
  status: OutcomeStatus;
  resultSummary: string;
  failedAttempts?: string;
  citedMemoryIds?: string[];
  verifier?: string;
  evidenceUri?: string;
  operatorFeedback?: -1 | 0 | 1;
  clientId?: string;
  logEpisodic?: boolean;
}

export interface GetOutcomesParams {
  namespace?: string;
  status?: OutcomeStatus | "all";
  hours?: number;
  limit?: number;
}

export type ValidationVerdict = "confirmed" | "weakened" | "invalid";

export type MemoryValidationRow = {
  validation_id: number;
  memory_id: string;
  verdict: ValidationVerdict;
  previous_confidence: number | null;
  new_confidence: number | null;
  evidence_uri: string | null;
  notes: string | null;
  client_id: string;
  observed_at: number;
  created_at: number;
};

export interface ValidateMemoryParams {
  memoryId: string;
  verdict: ValidationVerdict;
  evidenceUri?: string;
  notes?: string;
  observedAt?: number;
  autoRetireOnInvalid?: boolean;
  clientId?: string;
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
  namespace?: string;
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

export type MemoryConflictRow = {
  conflict_id: number;
  run_id: number | null;
  namespace: string;
  conflict_type: "semantic_contradiction" | "triple_conflict" | "adr_drift";
  severity: "low" | "medium" | "high";
  existing_memory_id: string | null;
  existing_title: string | null;
  existing_snippet: string | null;
  existing_edge_id: string | null;
  existing_decision_id: string | null;
  new_memory_id: string | null;
  new_title: string | null;
  new_snippet: string | null;
  new_edge_id: string | null;
  reason: string;
  suggested_action: "keep" | "supersede" | "merge";
  merged_content_proposal: string | null;
  status: "pending" | "resolved";
  resolution_action: "keep" | "supersede" | "merge" | null;
  resolved_by: string | null;
  created_at: number;
  resolved_at: number | null;
};

export interface GetConflictsParams {
  status?: "pending" | "resolved" | "all";
  namespace?: string;
  limit?: number;
}

export interface ResolveConflictParams {
  conflictId: number;
  action: "keep" | "supersede" | "merge";
  mergedContent?: string;
  clientId?: string;
}

export interface AuditContradictionsParams {
  memoryId?: string;
  runId?: number | null;
  hours?: number;
  namespace?: string;
  limit?: number;
}

export interface OvernightDiffParams {
  hours?: number;
  clientId?: string;
  namespace?: string;
  memoryId?: string;
  operation?: "ALL" | "INSERT" | "UPDATE" | "DELETE" | "CONSOLIDATE" | "ROLLBACK";
  excludeDaemons?: boolean;
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

export interface TextReplacementRule {
  pattern: string;
  flags?: string;
  replacement: string;
}

export interface ReplaceTextAcrossLayersParams {
  rules: TextReplacementRule[];
  dryRun?: boolean;
  reindexVectors?: boolean;
  includeSourceUri?: boolean;
  maxSamplesPerTable?: number;
}

export interface TextReplaceSample {
  table: string;
  rowId: string;
  column: string;
  before: string;
  after: string;
}

export interface ReclassifyNamespacesParams {
  sourceNamespace?: string;
  dryRun?: boolean;
  reindexVectors?: boolean;
  updateEdges?: boolean;
  includePrefixes?: string[];
  vectorOnlyIds?: string[];
  maxSamples?: number;
}

const VALID_BRAIN_NAMESPACES = new Set([
  "global",
  "tsimon.me",
  "minkalab.net",
  "homelab",
  "ai-research",
  "career"
]);

const PROTECTED_HOMELAB_ROUTE_RE =
  /(node:rpi5|rpi5-qdrant-knowledge-hub|edge-rag-hub|edge-semantic-search-rag|homelab-backup|homelab-ops|raspberry-pi-backup|backup-pi-restic|cf-state-backup|r2-offsite-sync|pi-apps-backup)/i;
const MINKALAB_ROUTE_RE =
  /(minkalab|minka[\s_-]lab|mallasa|escudo[\s_-]digital|gamlp|ciudad[\s_-]inteligente|ciudadan[ií]a[\s_-]digital)/i;
const TSIMON_ROUTE_RE =
  /(boliviaremote\.work|bolivia-remote|gemini[\s_-]brain|brain\.tsimon\.me|kb\.tsimon\.me|archive-rag-kb|tsimon\.me|tsimon-me-website)/i;
const CAREER_ROUTE_RE =
  /(az-?104|azure[\s_-]az-?104|microsoft and certifications|certification_path|learning_roadmap|career|freelanc|resume|pivot_strategy|short_term_strategy|hiring_non-us_contractor|mssp_consulting|data_engineer|ai_infrastructure_engineer|ai_solutions_engineer|synquery|outlier|innodata|personal profile summary)/i;
const AI_RESEARCH_ROUTE_RE =
  /(ai_agents|ai_core_concepts|neural networks|karpathy|behavioral_harness|harness_concepts|context_engineering|context tunning|context tuning|export gemini skills|automated ai research|qdrant_documentation|agentic workflows|01_ai[\s_-]|llm|rag[\s_-]pipeline|latam_solo_founder|south america tech funding)/i;

/**
 * Deterministic category/path/title -> Brain namespace router mirroring rpi-sync/brain_watcher.py.
 */
export function classifyMemoryNamespace(
  title: string,
  sourceUri: string | null | undefined,
  currentNamespace = "homelab"
): string {
  const safeDefault = VALID_BRAIN_NAMESPACES.has(currentNamespace) ? currentNamespace : "homelab";
  const qdrantMatch = title.match(/^\[Qdrant\/([^\]]+)\]\s*(.*)$/i);
  const category = qdrantMatch ? qdrantMatch[1].trim().toLowerCase() : "";
  const cleanTitle = qdrantMatch ? qdrantMatch[2].trim() : title;
  const blob = `${sourceUri || ""} ${cleanTitle}`.trim();

  if (PROTECTED_HOMELAB_ROUTE_RE.test(blob) && !MINKALAB_ROUTE_RE.test(category)) {
    return "homelab";
  }

  if (category.includes("minkalab")) return "minkalab.net";
  if (category === "boliviaremote.work" || category === "tsimon.me") return "tsimon.me";
  if (category === "career" || category === "microsoft") return "career";
  if (category === "ai" || category === "ai research" || category === "ai-research") {
    if (MINKALAB_ROUTE_RE.test(blob)) return "minkalab.net";
    if (TSIMON_ROUTE_RE.test(blob)) return "tsimon.me";
    if (CAREER_ROUTE_RE.test(blob)) return "career";
    return "ai-research";
  }

  if (MINKALAB_ROUTE_RE.test(blob)) return "minkalab.net";
  if (TSIMON_ROUTE_RE.test(blob)) return "tsimon.me";
  if (CAREER_ROUTE_RE.test(blob)) return "career";
  if (AI_RESEARCH_ROUTE_RE.test(blob)) return "ai-research";

  return safeDefault;
}

function isDaemonClientId(clientId: string | null | undefined): boolean {
  const c = (clientId || "").trim();
  return /^rpi5-debian13-daemon/i.test(c) || /^rpi5-qdrant-federator$/i.test(c);
}

const FUNCTIONAL_RELATIONS = new Set([
  "ROUTES_TO",
  "RUNS_ON",
  "HOSTED_ON",
  "USES_MODEL",
  "GOVERNED_BY",
  "LISTENS_ON",
  "PORT",
  "VERSION",
  "STATUS",
  "PRIMARY_DB",
  "REPLACES"
]);

/**
 * Safety guardrail: Protects Raspberry Pi 5 (node:rpi5) and Qdrant (service:rpi5-qdrant-knowledge-hub)
 * Knowledge Graph edges and active memories from automatic deprecation during contradiction triage.
 */
function isProtectedInfrastructure(value?: string | null): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.includes("node:rpi5") ||
    lower.includes("service:rpi5-qdrant-knowledge-hub") ||
    lower.includes("rpi5-qdrant")
  );
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
  if (uri.startsWith("rpi5-cli://")) return "antigravity-cli-rpi5";
  if (uri.startsWith("rpi5://")) return "rpi5-debian13-daemon";
  if (uri.startsWith("qdrant://")) return "rpi5-qdrant-federator";
  if (uri.includes("takeout")) return "takeout-ingestor";
  if (uri.includes("test_brain_mcp")) return "test-verifier";
  return "mcp-client";
}

const NOISY_EPISODIC_RPC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/roots/list_changed",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
  "logging/setLevel"
]);

function isNoisyProtocolEpisodicRow(row: EpisodicLogRow): boolean {
  if (row.event_type !== "tool_call") return false;
  try {
    const parsed = JSON.parse(row.payload) as { rpcMethod?: unknown; status?: unknown };
    const status = typeof parsed.status === "number" ? parsed.status : 200;
    return (
      status < 400 &&
      typeof parsed.rpcMethod === "string" &&
      NOISY_EPISODIC_RPC_METHODS.has(parsed.rpcMethod)
    );
  } catch {
    return false;
  }
}

export class BrainMemoryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize embedded SQLite schema & idempotent column migrations atomically before handling requests
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.sql.exec(SCHEMA_DDL);
        this.ensureSchemaMigrations();
      });
      await this.ensureAlarmScheduled();
    });
  }

  /**
   * Idempotent schema migrations for live Durable Objects created prior to v1.7.0.
   */
  private ensureSchemaMigrations(): void {
    const existingCols = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(memories)`)
        .toArray()
        .map((c) => c.name)
    );
    if (!existingCols.has("validated_count")) {
      this.sql.exec(`ALTER TABLE memories ADD COLUMN validated_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!existingCols.has("invalidated_count")) {
      this.sql.exec(`ALTER TABLE memories ADD COLUMN invalidated_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!existingCols.has("last_validated_at")) {
      this.sql.exec(`ALTER TABLE memories ADD COLUMN last_validated_at INTEGER`);
    }
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
   * Generates dense 1024-dim embeddings via Workers AI (@cf/baai/bge-m3) in safe,
   * context-budgeted chunks.
   *
   * Cloudflare Workers AI `@cf/baai/bge-m3` enforces a 60,000-token total batch context
   * window (`AiError 8007`) across all strings in `text: string[]`. Chunking by both
   * item count (<= 16) and total character budget (<= 24,000 chars) keeps every batch
   * well below 60,000 tokens even for dense code/JSON/multilingual text, and an adaptive
   * split-and-retry guard handles any pathological tokenization edge case.
   */
  private async embedTexts(texts: string[]): Promise<Array<number[] | undefined>> {
    if (texts.length === 0) return [];

    const MAX_BATCH_ITEMS = 16;
    const MAX_BATCH_CHARS = 24_000;
    const MAX_ITEM_CHARS = 3_800;

    const normalized = texts.map((t) =>
      t.length > MAX_ITEM_CHARS ? t.slice(0, MAX_ITEM_CHARS) : t
    );

    const isContextLimitError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return /\b8007\b|max context|context.*limit|too long|token/i.test(msg);
    };

    const runChunk = async (chunk: string[]): Promise<Array<number[] | undefined>> => {
      if (chunk.length === 0) return [];
      try {
        const res = (await this.env.AI.run(
          this.env.EMBEDDING_MODEL as "@cf/baai/bge-m3",
          {
            text: chunk,
            truncate_inputs: true
          }
        )) as { data?: number[][] };
        return chunk.map((_, idx) => res.data?.[idx]);
      } catch (err) {
        if (isContextLimitError(err)) {
          if (chunk.length > 1) {
            const mid = Math.ceil(chunk.length / 2);
            const left = await runChunk(chunk.slice(0, mid));
            const right = await runChunk(chunk.slice(mid));
            return [...left, ...right];
          }
          const single = chunk[0] ?? "";
          if (single.length > 512) {
            return runChunk([single.slice(0, Math.floor(single.length / 2))]);
          }
        }
        throw err;
      }
    };

    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentChars = 0;

    for (const item of normalized) {
      if (
        currentBatch.length > 0 &&
        (currentBatch.length >= MAX_BATCH_ITEMS || currentChars + item.length > MAX_BATCH_CHARS)
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push(item);
      currentChars += item.length;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    const results: Array<number[] | undefined> = [];
    for (const batch of batches) {
      const batchVectors = await runChunk(batch);
      results.push(...batchVectors);
    }
    return results;
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
    metadata?: Record<string, unknown>;
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
      metadata?: Record<string, unknown>;
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
      const metadataJson =
        input.metadata && typeof input.metadata === "object"
          ? JSON.stringify(input.metadata)
          : "{}";
      return {
        ...input,
        id,
        namespace,
        memoryType,
        summary,
        tokenCount,
        eventTs,
        clientId,
        metadataJson
      };
    });

    // 1. Generate 1024-dim dense embeddings in context-budgeted Workers AI batches (@cf/baai/bge-m3)
    const embeddedVectors = await this.embedTexts(
      prepared.map((p) => `${p.title.slice(0, 300)}\n${p.content.slice(0, 3500)}`)
    );

    const mutationIds: number[] = [];

    // 2. Write all memories + mutation audit trail + entity-relation triples in one atomic SQLite transaction
    this.ctx.storage.transactionSync(() => {
      for (const p of prepared) {
        const existingRows = this.sql
          .exec<{
            id: string;
            namespace: string;
            title: string;
            content: string;
            summary: string | null;
            importance: number;
          }>(
            `SELECT id, namespace, title, content, summary, importance
             FROM memories
             WHERE id = ?1`,
            p.id
          )
          .toArray();
        const existing = existingRows[0];

        this.sql.exec(
          `INSERT INTO memories (
            id, namespace, memory_type, title, content, summary, source_uri,
            token_count, importance, confidence, metadata_json, created_at, updated_at, last_accessed_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)
          ON CONFLICT(id) DO UPDATE SET
            namespace = excluded.namespace,
            title = excluded.title,
            content = excluded.content,
            summary = excluded.summary,
            source_uri = excluded.source_uri,
            token_count = excluded.token_count,
            importance = excluded.importance,
            confidence = excluded.confidence,
            metadata_json = CASE WHEN excluded.metadata_json != '{}' THEN excluded.metadata_json ELSE memories.metadata_json END,
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
          p.metadataJson,
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
        } else if (
          existing.title !== p.title ||
          existing.content !== p.content ||
          existing.namespace !== p.namespace
        ) {
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
          const normRel = t.relation.trim().toUpperCase();

          // Detect conflicting active Knowledge Graph triples on functional single-target relations
          if (FUNCTIONAL_RELATIONS.has(normRel) && !isProtectedInfrastructure(edgeId)) {
            const conflictingEdges = this.sql
              .exec<{
                edge_id: string;
                target_entity: string;
                evidence_memory_id: string | null;
              }>(
                `SELECT edge_id, target_entity, evidence_memory_id
                 FROM edges
                 WHERE source_entity = ?1
                   AND relation = ?2
                   AND target_entity != ?3
                   AND valid_until IS NULL`,
                t.subjectId,
                t.relation,
                t.objectId
              )
              .toArray();

            for (const ce of conflictingEdges) {
              if (isProtectedInfrastructure(ce.edge_id)) continue;
              const alreadyFlagged = this.sql
                .exec<{ cnt: number }>(
                  `SELECT COUNT(*) AS cnt
                   FROM memory_conflicts
                   WHERE existing_edge_id = ?1
                     AND new_edge_id = ?2
                     AND status = 'pending'`,
                  ce.edge_id,
                  edgeId
                )
                .one().cnt;

              if (alreadyFlagged === 0) {
                const oldMemRow = ce.evidence_memory_id
                  ? this.sql
                      .exec<{ title: string; summary: string | null; content: string }>(
                        `SELECT title, summary, content FROM memories WHERE id = ?1`,
                        ce.evidence_memory_id
                      )
                      .toArray()[0]
                  : undefined;

                this.sql.exec(
                  `INSERT INTO memory_conflicts (
                     run_id, namespace, conflict_type, severity,
                     existing_memory_id, existing_title, existing_snippet, existing_edge_id,
                     new_memory_id, new_title, new_snippet, new_edge_id,
                     reason, suggested_action, merged_content_proposal, status, created_at
                   ) VALUES (
                     NULL, ?1, 'triple_conflict', 'medium',
                     ?2, ?3, ?4, ?5,
                     ?6, ?7, ?8, ?9,
                     ?10, 'supersede', NULL, 'pending', ?11
                   )`,
                  p.namespace,
                  ce.evidence_memory_id,
                  oldMemRow?.title || ce.edge_id,
                  (oldMemRow?.summary || oldMemRow?.content || `Triple: ${ce.edge_id}`).slice(0, 280),
                  ce.edge_id,
                  p.id,
                  p.title,
                  (p.summary || p.content).slice(0, 280),
                  edgeId,
                  `Entity '${t.subjectId}' relation '${t.relation}' shifted target from '${ce.target_entity}' to '${t.objectId}'.`,
                  now
                );
              }
            }
          }

          this.sql.exec(
            `INSERT INTO edges (
              edge_id, namespace, source_entity, relation, target_entity, evidence_memory_id, valid_from
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(edge_id) DO UPDATE SET
              namespace = CASE WHEN ?8 = 1 THEN edges.namespace ELSE excluded.namespace END,
              evidence_memory_id = excluded.evidence_memory_id,
              valid_until = NULL`,
            edgeId,
            p.namespace,
            t.subjectId,
            t.relation,
            t.objectId,
            p.id,
            p.eventTs,
            isProtectedInfrastructure(edgeId) ? 1 : 0
          );
        }
      }
    });

    // 3. Upsert dense vectors into Cloudflare Vectorize
    const vectors: VectorizeVector[] = [];
    prepared.forEach((p, idx) => {
      const vec = embeddedVectors[idx];
      if (vec) {
        vectors.push({
          id: p.id,
          values: vec,
          namespace: p.namespace,
          metadata: {
            namespace: p.namespace,
            title: p.title.slice(0, 500),
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
    reranked: boolean;
    candidates: Array<
      RankedCandidate & {
        rrfScore: number;
        rerankScore?: number;
        sources: string[];
        explanation?: ScoreExplanation;
      }
    >;
    graphTriples: GraphTriple[];
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
      memoryType: row.memory_type,
      title: `[${row.namespace}] ${row.title}`,
      content: row.content,
      summary: row.summary,
      uri: row.source_uri || `brain://${row.namespace}/${row.id}`,
      namespace: row.namespace,
      rawScore: row.raw_bm25,
      importance: row.importance ?? 0.6,
      confidence: row.confidence ?? 1.0,
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
        memoryType: rec.memory_type,
        title: `[${rec.namespace}] ${rec.title}`,
        content: rec.content,
        summary: rec.summary,
        uri: rec.source_uri || `brain://${rec.namespace}/${rec.id}`,
        namespace: rec.namespace,
        rawScore: match.score,
        importance: rec.importance ?? 0.6,
        confidence: rec.confidence ?? 1.0,
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

    // Fetch active ADRs (up to 25) and prioritize query-relevant + namespace-specific rules first
    // so older foundational ADRs (e.g., ADR-01..ADR-06) are never pushed out by newer decisions.
    const adrRows = this.sql
      .exec<ActiveDecisionRow>(
        `SELECT decision_id, namespace, title, decision, rationale, created_at
         FROM decisions
         WHERE (?1 = 'global' OR namespace = ?1 OR namespace = 'global')
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 25`,
        namespace
      )
      .toArray();

    const adrQueryTokens = Array.from(
      new Set(
        params.query
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_.\-/]/gu, " ")
          .split(/\s+/)
          .filter((t) => t.length >= 2)
      )
    );

    const rankedAdrs = adrRows
      .map((r) => {
        const haystack = `${r.decision_id} ${r.title} ${r.decision}`.toLowerCase();
        let matchScore = 0;
        for (const tok of adrQueryTokens) {
          if (haystack.includes(tok)) {
            matchScore += r.title.toLowerCase().includes(tok) ? 3 : 1;
          }
        }
        if (namespace !== "global" && r.namespace === namespace) {
          matchScore += 0.5;
        }
        return { row: r, matchScore };
      })
      .sort((a, b) => b.matchScore - a.matchScore || b.row.created_at - a.row.created_at);

    const activeDecisionLines = rankedAdrs.map(({ row: r }) => {
      const compactDecision = r.decision.replace(/\s+/g, " ").trim();
      const snippet =
        compactDecision.length > 240
          ? `${compactDecision.slice(0, 237)}...`
          : compactDecision;
      return `- **[${r.decision_id}] (${r.namespace || "global"}) ${r.title}**: ${snippet}`;
    });

    const extraTriples = graphTriples.map((t) => ({
      subject: t.subject_name,
      predicate: t.relation,
      object: t.object_name
    }));

    // Step 4: Execute 4-Way Weighted Reciprocal Rank Fusion + Stage-2 Cross-Encoder Reranking
    const fused = await fuseBrainAndKb({
      env: this.env,
      query: params.query,
      brainFts: brainFtsCandidates,
      brainVec: brainVecCandidates,
      kbFts: kbArchiveRes.ftsResults,
      kbVec: kbArchiveRes.vecResults,
      activeDecisions: activeDecisionLines,
      extraTriples,
      tokenBudget,
      halfLifeDays: params.halfLifeDays,
      explain: params.explain
    });

    // Telemetry only (not used in ranking): increment recall counters only for Brain memories
    // that actually survived reranking and token-budget packing into <brain_context>.
    const selectedBrainIds = Array.from(
      new Set(
        fused.candidates
          .filter((c) => c.origin === "brain.tsimon.me")
          .map((c) => (c.id.startsWith("brain:") ? c.id.slice("brain:".length) : c.id))
          .filter(Boolean)
      )
    );
    if (selectedBrainIds.length > 0) {
      this.sql.exec(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?2
         WHERE id IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(selectedBrainIds),
        now
      );
    }

    return {
      compiledMarkdown: fused.contextBlock,
      tokensUsed: fused.totalTokens,
      tokenBudget: fused.tokenBudget,
      matchedCount: fused.selectedCount,
      brainCount: fused.brainCount,
      kbCount: fused.kbCount,
      graphTriplesCount: fused.graphTriplesCount,
      reranked: fused.reranked,
      candidates: fused.candidates,
      graphTriples
    };
  }

  /**
   * RPC Method 3: Log an Immutable Architecture Decision Record (ADR)
   *               Optionally records rejected alternatives and explicit revisit conditions.
   */
  async logDecision(input: {
    namespace?: string;
    title: string;
    decision: string;
    rationale: string;
    rejectedOptions?: string[];
    revisitWhen?: string[];
    supersedesDecisionId?: string;
  }): Promise<{ decisionId: string; status: string }> {
    const decisionId = `adr_${crypto.randomUUID().slice(0, 8)}`;
    const namespace = input.namespace || this.env.DEFAULT_NAMESPACE || "global";
    const now = Math.floor(Date.now() / 1000);

    const rationaleParts = [input.rationale.trim()];
    const cleanRejected = (input.rejectedOptions ?? []).map((s) => s.trim()).filter(Boolean);
    if (cleanRejected.length > 0) {
      rationaleParts.push(
        `\n**Rejected Options**:\n${cleanRejected.map((item) => `- ${item}`).join("\n")}`
      );
    }
    const cleanRevisit = (input.revisitWhen ?? []).map((s) => s.trim()).filter(Boolean);
    if (cleanRevisit.length > 0) {
      rationaleParts.push(
        `\n**Revisit When**:\n${cleanRevisit.map((item) => `- ${item}`).join("\n")}`
      );
    }
    const fullRationale = rationaleParts.join("\n");

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO decisions (decision_id, namespace, title, decision, rationale, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)`,
        decisionId,
        namespace,
        input.title,
        input.decision,
        fullRationale,
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
   * RPC Method 3B: Deliberate Memory Retirement / Deletion (soft_retire or hard_delete)
   *                Preserves RPi5/Qdrant safety guardrails, cleans Vectorize & KG edges,
   *                and records audit trail (scrubbing content on hard_delete).
   */
  async forgetMemory(params: ForgetMemoryParams): Promise<{
    ok: boolean;
    memoryId: string;
    mode?: "soft_retire" | "hard_delete";
    vectorDeleted?: boolean;
    retiredEdgesCount?: number;
    mutationId?: number;
    error?: string;
  }> {
    const memoryId = (params.memoryId || "").trim();
    const mode = params.mode === "hard_delete" ? "hard_delete" : "soft_retire";
    const retireLinkedEdges = params.retireLinkedEdges !== false;
    const clientId = (params.clientId || "mcp-forget").trim();
    const reason = (params.reason || `Deliberate ${mode} requested by operator`).trim();

    if (!memoryId) {
      return { ok: false, memoryId: "", error: "memoryId is required." };
    }

    const existing = this.sql
      .exec<{
        id: string;
        namespace: string;
        memory_type: string;
        title: string;
        content: string;
        summary: string | null;
        importance: number;
        source_uri: string | null;
        superseded_by: string | null;
      }>(
        `SELECT id, namespace, memory_type, title, content, summary, importance, source_uri, superseded_by
         FROM memories
         WHERE id = ?1`,
        memoryId
      )
      .toArray()[0];

    if (!existing) {
      return { ok: false, memoryId, error: `Memory '${memoryId}' not found.` };
    }

    if (isProtectedInfrastructure(existing.id) || isProtectedInfrastructure(existing.title)) {
      return {
        ok: false,
        memoryId,
        error:
          "Safety Guardrail: Raspberry Pi 5 (node:rpi5) and Qdrant (service:rpi5-qdrant-knowledge-hub) records are protected and cannot be forgotten."
      };
    }

    const now = Math.floor(Date.now() / 1000);
    let retiredEdgesCount = 0;
    let mutationId: number | undefined;

    this.ctx.storage.transactionSync(() => {
      if (retireLinkedEdges) {
        const linkedEdges = this.sql
          .exec<{ edge_id: string }>(
            `SELECT edge_id
             FROM edges
             WHERE evidence_memory_id = ?1
               AND valid_until IS NULL`,
            memoryId
          )
          .toArray()
          .filter((e) => !isProtectedInfrastructure(e.edge_id));

        if (linkedEdges.length > 0) {
          const edgeIdsJson = JSON.stringify(linkedEdges.map((e) => e.edge_id));
          if (mode === "hard_delete") {
            this.sql.exec(
              `DELETE FROM edges WHERE edge_id IN (SELECT value FROM json_each(?1))`,
              edgeIdsJson
            );
          } else {
            this.sql.exec(
              `UPDATE edges
               SET valid_until = ?1
               WHERE edge_id IN (SELECT value FROM json_each(?2))`,
              now,
              edgeIdsJson
            );
          }
          retiredEdgesCount = linkedEdges.length;
        }
      }

      if (mode === "soft_retire") {
        // Self-reference satisfies FK while removing from FTS5 triggers & active queries;
        // fully reversible via rollbackMutation(mutationId) including expired KG edges.
        this.sql.exec(
          `UPDATE memories
           SET superseded_by = ?1,
               updated_at = ?2
           WHERE id = ?1`,
          memoryId,
          now
        );

        const mutRow = this.sql
          .exec<{ mutation_id: number }>(
            `INSERT INTO memory_mutations (
               memory_id, namespace, memory_type, operation, client_id,
               old_title, old_content, old_summary, old_importance,
               new_title, new_content, new_summary, new_importance,
               source_uri, rolled_back, created_at
             ) VALUES (?1, ?2, ?3, 'DELETE', ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, 0, ?13)
             RETURNING mutation_id`,
            existing.id,
            existing.namespace,
            existing.memory_type,
            clientId,
            existing.title,
            existing.content,
            existing.summary,
            existing.importance,
            `[SOFT_RETIRED] ${existing.title}`,
            reason.slice(0, 280),
            existing.importance,
            existing.source_uri,
            now
          )
          .one();
        mutationId = mutRow.mutation_id;
      } else {
        // Permanent erasure: clear any self/incoming superseded_by FK refs, delete row, and scrub audit text
        this.sql.exec(
          `UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?1`,
          memoryId
        );
        this.sql.exec(`DELETE FROM memories WHERE id = ?1`, memoryId);
        this.sql.exec(
          `UPDATE memory_mutations
           SET old_content = CASE WHEN old_content IS NOT NULL THEN '[HARD_DELETED]' ELSE NULL END,
               new_content = CASE WHEN new_content IS NOT NULL THEN '[HARD_DELETED]' ELSE NULL END,
               old_summary = CASE WHEN old_summary IS NOT NULL THEN '[HARD_DELETED]' ELSE NULL END,
               new_summary = CASE WHEN new_summary IS NOT NULL THEN '[HARD_DELETED]' ELSE NULL END
           WHERE memory_id = ?1`,
          memoryId
        );
        const mutRow = this.sql
          .exec<{ mutation_id: number }>(
            `INSERT INTO memory_mutations (
               memory_id, namespace, memory_type, operation, client_id,
               old_title, old_content, old_summary, old_importance,
               new_title, new_content, new_summary, new_importance,
               source_uri, rolled_back, created_at
             ) VALUES (?1, ?2, ?3, 'DELETE', ?4, ?5, NULL, NULL, ?6, '[HARD_DELETED]', NULL, ?7, 0, ?8, 0, ?9)
             RETURNING mutation_id`,
            existing.id,
            existing.namespace,
            existing.memory_type,
            clientId,
            existing.title,
            existing.importance,
            reason.slice(0, 280),
            existing.source_uri,
            now
          )
          .one();
        mutationId = mutRow.mutation_id;
      }
    });

    let vectorDeleted = false;
    try {
      await this.env.VECTOR_INDEX.deleteByIds([memoryId]);
      vectorDeleted = true;
    } catch {
      vectorDeleted = false;
    }

    return {
      ok: true,
      memoryId,
      mode,
      vectorDeleted,
      retiredEdgesCount,
      mutationId
    };
  }

  /**
   * RPC Method 3C: Record a First-Class Task Outcome (Attempted Plan + Observed Result + Failed Attempts)
   *                Only adjusts cited memory confidence conservatively when explicitly verified
   *                (verifier or operatorFeedback present), preventing noisy LLM self-attribution loops.
   */
  async recordOutcome(params: RecordOutcomeParams): Promise<{
    ok: boolean;
    outcomeId: string;
    status: OutcomeStatus;
    updatedMemoryIds: string[];
    episodicLogId?: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const outcomeId = (params.outcomeId || `out_${crypto.randomUUID().slice(0, 12)}`).slice(0, 64);
    const namespace = (params.namespace || this.env.DEFAULT_NAMESPACE || "global").trim();
    const clientId = (params.clientId || "mcp-outcome").trim();
    const citedIds = Array.from(
      new Set(
        (params.citedMemoryIds ?? [])
          .map((id) => id.trim())
          .map((id) => (id.startsWith("brain:") ? id.slice("brain:".length) : id))
          .filter(Boolean)
      )
    );
    const updatedMemoryIds: string[] = [];

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO outcomes (
           outcome_id, session_id, namespace, task_type, query, status,
           result_summary, failed_attempts, cited_memory_ids_json,
           verifier, evidence_uri, operator_feedback, client_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(outcome_id) DO UPDATE SET
           status = excluded.status,
           result_summary = excluded.result_summary,
           failed_attempts = excluded.failed_attempts,
           cited_memory_ids_json = excluded.cited_memory_ids_json,
           verifier = excluded.verifier,
           evidence_uri = excluded.evidence_uri,
           operator_feedback = excluded.operator_feedback`,
        outcomeId,
        params.sessionId,
        namespace,
        params.taskType,
        params.query,
        params.status,
        params.resultSummary,
        params.failedAttempts?.trim() || null,
        JSON.stringify(citedIds),
        params.verifier?.trim() || null,
        params.evidenceUri?.trim() || null,
        typeof params.operatorFeedback === "number" ? params.operatorFeedback : null,
        clientId,
        now
      );

      // Apply bounded confidence nudge ONLY when outcome is backed by an explicit verifier or operatorFeedback
      const hasExternalVerification =
        Boolean(params.verifier?.trim()) || typeof params.operatorFeedback === "number";

      if (citedIds.length > 0 && hasExternalVerification) {
        const isPositive =
          params.status === "success" &&
          (params.operatorFeedback === 1 ||
            (params.operatorFeedback === undefined && Boolean(params.verifier?.trim())));
        const isNegative = params.status === "failure" && params.operatorFeedback === -1;

        if (isPositive || isNegative) {
          const matchedRows = this.sql
            .exec<{ id: string }>(
              `SELECT id FROM memories
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND superseded_by IS NULL`,
              JSON.stringify(citedIds)
            )
            .toArray();

          for (const row of matchedRows) {
            if (isPositive) {
              this.sql.exec(
                `UPDATE memories
                 SET validated_count = validated_count + 1,
                     last_validated_at = ?1,
                     confidence = MIN(1.0, confidence + 0.05)
                 WHERE id = ?2`,
                now,
                row.id
              );
            } else {
              this.sql.exec(
                `UPDATE memories
                 SET invalidated_count = invalidated_count + 1,
                     last_validated_at = ?1,
                     confidence = MAX(0.2, confidence - 0.10)
                 WHERE id = ?2`,
                now,
                row.id
              );
            }
            updatedMemoryIds.push(row.id);
          }
        }
      }
    });

    let episodicLogId: number | undefined;
    if (params.logEpisodic !== false) {
      const episodicParts = [
        `[Outcome ${outcomeId} | ${params.status.toUpperCase()} | ${params.taskType} | ns=${namespace}]`,
        `Task: ${params.query}`,
        `Result: ${params.resultSummary}`
      ];
      if (params.failedAttempts?.trim()) {
        episodicParts.push(`Failed Attempts: ${params.failedAttempts.trim()}`);
      }
      if (citedIds.length > 0) {
        episodicParts.push(`Cited Memories: ${citedIds.join(", ")}`);
      }
      if (params.verifier?.trim()) {
        episodicParts.push(`Verifier: ${params.verifier.trim()}`);
      }
      const ev = await this.logEpisodicEvent({
        sessionId: params.sessionId,
        clientId,
        eventType: params.status === "failure" ? "error_resolution" : "checkpoint",
        payload: episodicParts.join("\n")
      });
      episodicLogId = ev.logId;
    }

    return {
      ok: true,
      outcomeId,
      status: params.status,
      updatedMemoryIds,
      episodicLogId
    };
  }

  /**
   * RPC Method 3D: Query Recorded Outcomes & Aggregate Task Success Telemetry
   */
  async getOutcomes(params: GetOutcomesParams = {}): Promise<{
    total: number;
    byStatus: Record<string, number>;
    successRate: number | null;
    outcomes: OutcomeRow[];
  }> {
    const nsFilter = (params.namespace || "").trim();
    const statusFilter = (params.status || "all").trim().toLowerCase();
    const hours = Math.max(1, Math.min(8760, params.hours ?? 720));
    const sinceUnix = Math.floor(Date.now() / 1000) - Math.floor(hours * 3600);
    const limit = Math.max(1, Math.min(200, params.limit ?? 40));

    const outcomes = this.sql
      .exec<OutcomeRow>(
        `SELECT
           outcome_id, session_id, namespace, task_type, query, status,
           result_summary, failed_attempts, cited_memory_ids_json,
           verifier, evidence_uri, operator_feedback, client_id, created_at
         FROM outcomes
         WHERE created_at >= ?1
           AND (?2 = '' OR namespace = ?2)
           AND (?3 = 'all' OR status = ?3)
         ORDER BY created_at DESC
         LIMIT ?4`,
        sinceUnix,
        nsFilter,
        statusFilter,
        limit
      )
      .toArray();

    const byStatus: Record<string, number> = {};
    for (const o of outcomes) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    }
    const successRate =
      outcomes.length > 0
        ? Number(((byStatus["success"] || 0) / outcomes.length).toFixed(4))
        : null;

    return {
      total: outcomes.length,
      byStatus,
      successRate,
      outcomes
    };
  }

  /**
   * RPC Method 3E: Evidence-Backed Memory Validation (confirmed | weakened | invalid)
   *                Updates epistemic confidence, validation counters, and freshness on confirmation,
   *                records immutable provenance in memory_validations, and optionally soft-retires invalid facts.
   */
  async validateMemory(params: ValidateMemoryParams): Promise<{
    ok: boolean;
    validationId?: number;
    memoryId: string;
    verdict?: ValidationVerdict;
    previousConfidence?: number;
    newConfidence?: number;
    validatedCount?: number;
    invalidatedCount?: number;
    retired?: boolean;
    error?: string;
  }> {
    const rawId = (params.memoryId || "").trim();
    const memoryId = rawId.startsWith("brain:") ? rawId.slice("brain:".length) : rawId;
    const verdict = params.verdict;
    const clientId = (params.clientId || "mcp-validate").trim();
    const now = Math.floor(Date.now() / 1000);
    const observedAt =
      typeof params.observedAt === "number" && params.observedAt > 0
        ? Math.floor(params.observedAt)
        : now;

    if (!memoryId || !["confirmed", "weakened", "invalid"].includes(verdict)) {
      return {
        ok: false,
        memoryId,
        error: "Valid memoryId and verdict ('confirmed' | 'weakened' | 'invalid') are required."
      };
    }

    const existing = this.sql
      .exec<{
        id: string;
        confidence: number;
        validated_count: number;
        invalidated_count: number;
        updated_at: number;
        superseded_by: string | null;
      }>(
        `SELECT id, confidence, validated_count, invalidated_count, updated_at, superseded_by
         FROM memories
         WHERE id = ?1`,
        memoryId
      )
      .toArray()[0];

    if (!existing) {
      return { ok: false, memoryId, error: `Memory '${memoryId}' not found.` };
    }
    if (existing.superseded_by !== null) {
      return {
        ok: false,
        memoryId,
        error: `Memory '${memoryId}' is already retired/superseded by '${existing.superseded_by}'.`
      };
    }

    const prevConf = Number(existing.confidence ?? 1.0);
    let newConf = prevConf;
    let newValidated = Number(existing.validated_count ?? 0);
    let newInvalidated = Number(existing.invalidated_count ?? 0);

    if (verdict === "confirmed") {
      newConf = Number(Math.min(1.0, Math.max(prevConf + 0.15, 0.9)).toFixed(3));
      newValidated += 1;
    } else if (verdict === "weakened") {
      newConf = Number(Math.max(0.25, prevConf - 0.3).toFixed(3));
      newInvalidated += 1;
    } else {
      newConf = 0.05;
      newInvalidated += 1;
    }

    let validationId = 0;
    this.ctx.storage.transactionSync(() => {
      if (verdict === "confirmed") {
        // Refresh updated_at on explicit confirmation so verified durable facts reset decay
        this.sql.exec(
          `UPDATE memories
           SET confidence = ?1,
               validated_count = ?2,
               last_validated_at = ?3,
               updated_at = MAX(updated_at, ?3)
           WHERE id = ?4`,
          newConf,
          newValidated,
          observedAt,
          memoryId
        );
      } else {
        this.sql.exec(
          `UPDATE memories
           SET confidence = ?1,
               invalidated_count = ?2,
               last_validated_at = ?3
           WHERE id = ?4`,
          newConf,
          newInvalidated,
          observedAt,
          memoryId
        );
      }

      const vRow = this.sql
        .exec<{ validation_id: number }>(
          `INSERT INTO memory_validations (
             memory_id, verdict, previous_confidence, new_confidence,
             evidence_uri, notes, client_id, observed_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           RETURNING validation_id`,
          memoryId,
          verdict,
          prevConf,
          newConf,
          params.evidenceUri?.trim() || null,
          params.notes?.trim() || null,
          clientId,
          observedAt,
          now
        )
        .one();
      validationId = vRow.validation_id;
    });

    let retired = false;
    if (verdict === "invalid" && params.autoRetireOnInvalid === true) {
      const retireRes = await this.forgetMemory({
        memoryId,
        mode: "soft_retire",
        reason: params.notes?.trim() || `Validated invalid (validation #${validationId})`,
        clientId
      });
      retired = Boolean(retireRes.ok);
    }

    return {
      ok: true,
      validationId,
      memoryId,
      verdict,
      previousConfidence: prevConf,
      newConfidence: newConf,
      validatedCount: newValidated,
      invalidatedCount: newInvalidated,
      retired
    };
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
   * RPC Method 4B: Purge matching rows from episodic_logs (requires at least one explicit filter).
   */
  async purgeEpisodicLogs(input: {
    clientId?: string;
    eventType?: "tool_call" | "observation" | "checkpoint" | "error_resolution";
    consolidatedOnly?: boolean;
    dryRun?: boolean;
  }): Promise<{
    ok: boolean;
    dryRun: boolean;
    matchedCount: number;
    deletedCount: number;
    remainingTotal: number;
    remainingPending: number;
    filters: {
      clientId: string | null;
      eventType: string | null;
      consolidatedOnly: boolean;
    };
  }> {
    const clientFilter = (input.clientId || "").trim();
    const validTypes = new Set(["tool_call", "observation", "checkpoint", "error_resolution"]);
    const eventTypeFilter =
      input.eventType && validTypes.has(input.eventType) ? input.eventType : "";
    const consolidatedOnly = input.consolidatedOnly === true;
    const dryRun = input.dryRun === true;

    if (!clientFilter && !eventTypeFilter) {
      throw new Error("purgeEpisodicLogs requires at least one of 'clientId' or 'eventType'.");
    }

    const whereSql =
      `WHERE (?1 = '' OR client_id = ?1)
         AND (?2 = '' OR event_type = ?2)
         AND (?3 = 0 OR consolidated = 1)`;

    let matchedCount = 0;
    let deletedCount = 0;

    if (dryRun) {
      matchedCount = this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM episodic_logs ${whereSql}`,
          clientFilter,
          eventTypeFilter,
          consolidatedOnly ? 1 : 0
        )
        .one().count;
    } else {
      this.ctx.storage.transactionSync(() => {
        matchedCount = this.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM episodic_logs ${whereSql}`,
            clientFilter,
            eventTypeFilter,
            consolidatedOnly ? 1 : 0
          )
          .one().count;
        if (matchedCount > 0) {
          this.sql.exec(
            `DELETE FROM episodic_logs ${whereSql}`,
            clientFilter,
            eventTypeFilter,
            consolidatedOnly ? 1 : 0
          );
          deletedCount = matchedCount;
        }
      });
    }

    const remainingTotal = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM episodic_logs`)
      .one().count;
    const remainingPending = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM episodic_logs WHERE consolidated = 0`)
      .one().count;

    return {
      ok: true,
      dryRun,
      matchedCount,
      deletedCount,
      remainingTotal,
      remainingPending,
      filters: {
        clientId: clientFilter || null,
        eventType: eventTypeFilter || null,
        consolidatedOnly
      }
    };
  }

  /**
   * RPC Method 5: Retrieve Active Architecture Decision Records (ADRs) as Markdown across All or Specific Namespaces
   */
  async getActiveDecisions(namespace = "all"): Promise<string> {
    const scope = namespace.trim() || "all";
    const rows = this.sql
      .exec<ActiveDecisionRow>(
        `SELECT decision_id, namespace, title, decision, rationale, created_at
         FROM decisions
         WHERE (?1 = 'all' OR ?1 = 'global' OR namespace = ?1 OR namespace = 'global')
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 50`,
        scope
      )
      .toArray();

    const headerScope =
      scope === "all" || scope === "global" ? "All Namespaces" : scope;

    if (rows.length === 0) {
      return `# Active Architecture Decision Records (${headerScope})\n\n_No active ADRs recorded._`;
    }

    const blocks = rows.map((r) => {
      const dateIso = new Date(r.created_at * 1000).toISOString().slice(0, 10);
      const ns = r.namespace || "global";
      return [
        `## [${r.decision_id}] (${ns}) ${r.title}`,
        `- **Namespace**: \`${ns}\``,
        `- **Date**: ${dateIso}`,
        `- **Decision**: ${r.decision}`,
        `- **Rationale**: ${r.rationale}`
      ].join("\n");
    });

    return `# Active Architecture Decision Records (${headerScope} — ${rows.length} Active)\n\n${blocks.join("\n\n")}`;
  }

  /**
   * RPC Method 6: Retrieve All-Namespace Telemetry, Breakdown & Consolidation Status
   */
  async getNamespaceStats(namespace = "all"): Promise<{
    scope: string;
    activeMemories: number;
    activeDecisions: number;
    activeEntities: number;
    activeEdges: number;
    pendingEpisodicLogs: number;
    pendingConflicts: number;
    nextAlarmIso: string | null;
    byNamespace: {
      memories: Record<string, number>;
      decisions: Record<string, number>;
      entities: Record<string, number>;
      edges: Record<string, number>;
    };
  }> {
    const scope = namespace.trim() || "all";
    const matchAll = scope === "all" || scope === "global" ? 1 : 0;

    const activeMemories = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE (?2 = 1 OR namespace = ?1 OR namespace = 'global')
           AND superseded_by IS NULL`,
        scope,
        matchAll
      )
      .one().count;

    const activeDecisions = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM decisions
         WHERE (?2 = 1 OR namespace = ?1 OR namespace = 'global')
           AND status = 'active'`,
        scope,
        matchAll
      )
      .one().count;

    const activeEntities = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM entities
         WHERE ?2 = 1 OR namespace = ?1 OR namespace = 'global'`,
        scope,
        matchAll
      )
      .one().count;

    const activeEdges = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM edges
         WHERE (?2 = 1 OR namespace = ?1 OR namespace = 'global')
           AND valid_until IS NULL`,
        scope,
        matchAll
      )
      .one().count;

    const pendingEpisodicLogs = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM episodic_logs
         WHERE consolidated = 0`
      )
      .one().count;

    const pendingConflicts = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM memory_conflicts
         WHERE status = 'pending'
           AND (?2 = 1 OR namespace = ?1 OR namespace = 'global')`,
        scope,
        matchAll
      )
      .one().count;

    const memByNsRows = this.sql
      .exec<{ namespace: string; count: number }>(
        `SELECT namespace, COUNT(*) AS count
         FROM memories
         WHERE superseded_by IS NULL
         GROUP BY namespace
         ORDER BY count DESC`
      )
      .toArray();

    const decByNsRows = this.sql
      .exec<{ namespace: string; count: number }>(
        `SELECT namespace, COUNT(*) AS count
         FROM decisions
         WHERE status = 'active'
         GROUP BY namespace
         ORDER BY count DESC`
      )
      .toArray();

    const entByNsRows = this.sql
      .exec<{ namespace: string; count: number }>(
        `SELECT namespace, COUNT(*) AS count
         FROM entities
         GROUP BY namespace
         ORDER BY count DESC`
      )
      .toArray();

    const edgByNsRows = this.sql
      .exec<{ namespace: string; count: number }>(
        `SELECT namespace, COUNT(*) AS count
         FROM edges
         WHERE valid_until IS NULL
         GROUP BY namespace
         ORDER BY count DESC`
      )
      .toArray();

    const toRecord = (rows: Array<{ namespace: string; count: number }>) => {
      const out: Record<string, number> = {};
      for (const r of rows) {
        out[r.namespace || "global"] = r.count;
      }
      return out;
    };

    const nextAlarmMs = await this.ctx.storage.getAlarm();

    return {
      scope: matchAll ? "all" : scope,
      activeMemories,
      activeDecisions,
      activeEntities,
      activeEdges,
      pendingEpisodicLogs,
      pendingConflicts,
      nextAlarmIso: nextAlarmMs !== null ? new Date(nextAlarmMs).toISOString() : null,
      byNamespace: {
        memories: toRecord(memByNsRows),
        decisions: toRecord(decByNsRows),
        entities: toRecord(entByNsRows),
        edges: toRecord(edgByNsRows)
      }
    };
  }

  /**
   * RPC Method 7: Query Overnight Mutations, Before/After Diffs, Pending Conflicts & Morning Session Hydration Context
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
      conflictsPending: number;
      conflictsResolved: number;
      outcomesRecorded: number;
      outcomeSuccessRate: number | null;
      nextAlarmIso: string | null;
    };
    conflicts: MemoryConflictRow[];
    outcomes: OutcomeRow[];
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
    const excludeDaemons = params.excludeDaemons === true;
    const daemonFilterFlag = excludeDaemons ? 1 : 0;

    // 1. Fetch explicit audit mutations in the window.
    //    When no explicit clientFilter is given and daemons aren't excluded, prioritize non-daemon
    //    architect/consolidator mutations first so high-volume RPi5 Qdrant/Markdown syncs never
    //    saturate the 50-row window and hide substantive architect mutations.
    let rawMutations: MutationAuditRow[];
    if (!clientFilter && !excludeDaemons && !memFilter) {
      const nonDaemonMutations = this.sql
        .exec<MutationAuditRow>(
          `SELECT
             mutation_id, memory_id, namespace, memory_type, operation, client_id,
             old_title, old_content, old_summary, old_importance,
             new_title, new_content, new_summary, new_importance,
             source_uri, rolled_back, created_at
           FROM memory_mutations
           WHERE created_at >= ?1
             AND (?2 = 'ALL' OR operation = ?2)
             AND (?3 = '' OR namespace = ?3)
             AND client_id NOT LIKE 'rpi5-debian13-daemon%'
             AND client_id != 'rpi5-qdrant-federator'
           ORDER BY created_at DESC, mutation_id DESC
           LIMIT ?4`,
          sinceUnix,
          opFilter,
          nsFilter,
          limit
        )
        .toArray();

      const remainingSlots = Math.max(0, limit - nonDaemonMutations.length);
      const daemonMutations =
        remainingSlots > 0
          ? this.sql
              .exec<MutationAuditRow>(
                `SELECT
                   mutation_id, memory_id, namespace, memory_type, operation, client_id,
                   old_title, old_content, old_summary, old_importance,
                   new_title, new_content, new_summary, new_importance,
                   source_uri, rolled_back, created_at
                 FROM memory_mutations
                 WHERE created_at >= ?1
                   AND (?2 = 'ALL' OR operation = ?2)
                   AND (?3 = '' OR namespace = ?3)
                   AND (client_id LIKE 'rpi5-debian13-daemon%' OR client_id = 'rpi5-qdrant-federator')
                 ORDER BY created_at DESC, mutation_id DESC
                 LIMIT ?4`,
                sinceUnix,
                opFilter,
                nsFilter,
                remainingSlots
              )
              .toArray()
          : [];

      rawMutations = [...nonDaemonMutations, ...daemonMutations];
    } else {
      rawMutations = this.sql
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
             AND (?6 = 0 OR (client_id NOT LIKE 'rpi5-debian13-daemon%' AND client_id != 'rpi5-qdrant-federator'))
           ORDER BY created_at DESC, mutation_id DESC
           LIMIT ?7`,
          memFilter,
          sinceUnix,
          opFilter,
          clientFilter,
          nsFilter,
          daemonFilterFlag,
          limit
        )
        .toArray();
    }

    // 2. Include fallback virtual entries ONLY for memories updated in the window that have NO row
    //    in memory_mutations (pre-audit legacy records), so filtered-out daemon/client mutations are never resurrected.
    const auditedIds = new Set(rawMutations.map((m) => m.memory_id));
    let fallbackAddedCount = 0;
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
             m.id, m.namespace, m.memory_type, m.title, m.content, m.summary, m.source_uri,
             m.importance, m.created_at, m.updated_at
           FROM memories m
           WHERE (?1 = '' OR m.id = ?1)
             AND (?1 != '' OR m.updated_at >= ?2)
             AND (?3 = '' OR m.namespace = ?3)
             AND m.superseded_by IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM memory_mutations mm
               WHERE mm.memory_id = m.id
                 AND (?1 != '' OR mm.created_at >= ?2)
             )
           ORDER BY m.updated_at DESC
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
        if (excludeDaemons && isDaemonClientId(inferredClient)) continue;
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
        fallbackAddedCount++;
        if (rawMutations.length >= limit) break;
      }
    }

    rawMutations.sort((a, b) => b.created_at - a.created_at || b.mutation_id - a.mutation_id);

    // 3. Aggregate TRUE uncapped window-wide summary counts from memory_mutations (+ any fallback pre-audit rows)
    const byOperation: Record<string, number> = {};
    const byClient: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};

    const opAgg = this.sql
      .exec<{ k: string; cnt: number }>(
        `SELECT operation AS k, COUNT(*) AS cnt
         FROM memory_mutations
         WHERE (?1 = '' OR memory_id = ?1)
           AND (?1 != '' OR created_at >= ?2)
           AND (?3 = 'ALL' OR operation = ?3)
           AND (?4 = '' OR client_id = ?4)
           AND (?5 = '' OR namespace = ?5)
           AND (?6 = 0 OR (client_id NOT LIKE 'rpi5-debian13-daemon%' AND client_id != 'rpi5-qdrant-federator'))
         GROUP BY operation`,
        memFilter,
        sinceUnix,
        opFilter,
        clientFilter,
        nsFilter,
        daemonFilterFlag
      )
      .toArray();
    const clientAgg = this.sql
      .exec<{ k: string; cnt: number }>(
        `SELECT client_id AS k, COUNT(*) AS cnt
         FROM memory_mutations
         WHERE (?1 = '' OR memory_id = ?1)
           AND (?1 != '' OR created_at >= ?2)
           AND (?3 = 'ALL' OR operation = ?3)
           AND (?4 = '' OR client_id = ?4)
           AND (?5 = '' OR namespace = ?5)
           AND (?6 = 0 OR (client_id NOT LIKE 'rpi5-debian13-daemon%' AND client_id != 'rpi5-qdrant-federator'))
         GROUP BY client_id
         ORDER BY cnt DESC`,
        memFilter,
        sinceUnix,
        opFilter,
        clientFilter,
        nsFilter,
        daemonFilterFlag
      )
      .toArray();
    const nsAgg = this.sql
      .exec<{ k: string; cnt: number }>(
        `SELECT namespace AS k, COUNT(*) AS cnt
         FROM memory_mutations
         WHERE (?1 = '' OR memory_id = ?1)
           AND (?1 != '' OR created_at >= ?2)
           AND (?3 = 'ALL' OR operation = ?3)
           AND (?4 = '' OR client_id = ?4)
           AND (?5 = '' OR namespace = ?5)
           AND (?6 = 0 OR (client_id NOT LIKE 'rpi5-debian13-daemon%' AND client_id != 'rpi5-qdrant-federator'))
         GROUP BY namespace
         ORDER BY cnt DESC`,
        memFilter,
        sinceUnix,
        opFilter,
        clientFilter,
        nsFilter,
        daemonFilterFlag
      )
      .toArray();

    let totalMutationsCount = 0;
    for (const row of opAgg) {
      byOperation[row.k] = row.cnt;
      totalMutationsCount += row.cnt;
    }
    for (const row of clientAgg) byClient[row.k] = row.cnt;
    for (const row of nsAgg) byNamespace[row.k] = row.cnt;

    if (fallbackAddedCount > 0) {
      for (const m of rawMutations) {
        if (m.mutation_id === 0) {
          byOperation[m.operation] = (byOperation[m.operation] || 0) + 1;
          byClient[m.client_id] = (byClient[m.client_id] || 0) + 1;
          byNamespace[m.namespace] = (byNamespace[m.namespace] || 0) + 1;
          totalMutationsCount++;
        }
      }
    }

    // 4. Fetch decisions, consolidations & governance conflicts
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

    const conflicts = this.sql
      .exec<MemoryConflictRow>(
        `SELECT
           conflict_id, run_id, namespace, conflict_type, severity,
           existing_memory_id, existing_title, existing_snippet, existing_edge_id, existing_decision_id,
           new_memory_id, new_title, new_snippet, new_edge_id,
           reason, suggested_action, merged_content_proposal,
           status, resolution_action, resolved_by, created_at, resolved_at
         FROM memory_conflicts
         WHERE (status = 'pending' OR created_at >= ?1 OR resolved_at >= ?1)
           AND (?2 = '' OR namespace = ?2)
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC, created_at DESC
         LIMIT 30`,
        sinceUnix,
        nsFilter
      )
      .toArray();

    const pendingConflicts = conflicts.filter((c) => c.status === "pending");
    const resolvedConflicts = conflicts.filter((c) => c.status === "resolved");

    const outcomes = this.sql
      .exec<OutcomeRow>(
        `SELECT
           outcome_id, session_id, namespace, task_type, query, status,
           result_summary, failed_attempts, cited_memory_ids_json,
           verifier, evidence_uri, operator_feedback, client_id, created_at
         FROM outcomes
         WHERE created_at >= ?1
           AND (?2 = '' OR namespace = ?2)
         ORDER BY created_at DESC
         LIMIT 20`,
        sinceUnix,
        nsFilter
      )
      .toArray();
    const outcomeSuccessRate =
      outcomes.length > 0
        ? Number(
            (outcomes.filter((o) => o.status === "success").length / outcomes.length).toFixed(4)
          )
        : null;

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
      `<overnight_brain_diff window_hours="${windowHours}" since="${sinceIso}" total_mutations="${totalMutationsCount}" decisions_added="${decisions.length}" episodic_pending="${episodicPendingCount}" conflicts_pending="${pendingConflicts.length}">`,
      `### Overnight Brain State Summary (Last ${windowHours}h)`,
      `- **Window**: \`${sinceIso}\` -> \`${new Date(now * 1000).toISOString()}\``,
      `- **Mutations**: ${totalMutationsCount} (${Object.entries(byOperation)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none"})${totalMutationsCount > rawMutations.length ? ` — returning ${rawMutations.length} prioritized rows` : ""}`,
      `- **By Client**: ${Object.entries(byClient)
        .map(([k, v]) => `\`${k}\` (${v})`)
        .join(", ") || "none"}`,
      `- **By Namespace**: ${Object.entries(byNamespace)
        .map(([k, v]) => `\`${k}\` (${v})`)
        .join(", ") || "none"}`,
      `- **Governance Watchdog**: ${pendingConflicts.length} pending conflict(s) | ${resolvedConflicts.length} resolved in window`,
      `- **Task Outcomes**: ${outcomes.length} recorded in window${outcomeSuccessRate !== null ? ` (${Math.round(outcomeSuccessRate * 100)}% success)` : ""}`,
      `- **Episodic Buffer**: ${episodicLoggedCount} logged in window | ${episodicPendingCount} pending consolidation | Next 03:00 AM alarm: \`${nextAlarmIso || "unscheduled"}\``
    ];

    if (pendingConflicts.length > 0) {
      mdLines.push(`\n### ⚠️ Pending Semantic Contradictions (15s Triage Required: keep | supersede | merge)`);
      for (const c of pendingConflicts) {
        const oldRef = c.existing_memory_id || c.existing_edge_id || c.existing_decision_id || "unknown";
        const newRef = c.new_memory_id || c.new_edge_id || "latest";
        mdLines.push(
          `- **[Conflict #${c.conflict_id}] (${c.severity.toUpperCase()} | ${c.conflict_type})** \`[${c.namespace}]\` — Recommended: **\`${c.suggested_action}\`**`,
          `  - **Why Flagged**: ${c.reason}`,
          `  - **Existing (\`${oldRef}\`)**: ${c.existing_title || oldRef} — _${(c.existing_snippet || "").replace(/\s+/g, " ").slice(0, 180)}_`,
          `  - **New (\`${newRef}\`)**: ${c.new_title || newRef} — _${(c.new_snippet || "").replace(/\s+/g, " ").slice(0, 180)}_`,
          `  - **Triage Action**: Call MCP \`resolve_conflict\` with \`{ "conflictId": ${c.conflict_id}, "action": "${c.suggested_action}" }\` or run \`python brain_monitor.py triage\``
        );
      }
    }

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
      // Reserve top display slots for non-daemon architect/consolidator mutations first so daemon bulk syncs never mask them
      const displayMutations =
        !clientFilter && !excludeDaemons
          ? (() => {
              const nonDaemon = rawMutations.filter((m) => !isDaemonClientId(m.client_id));
              const daemon = rawMutations.filter((m) => isDaemonClientId(m.client_id));
              if (nonDaemon.length === 0) return daemon.slice(0, 15);
              if (daemon.length === 0) return nonDaemon.slice(0, 15);
              const daemonQuota = Math.min(3, daemon.length, Math.max(0, 15 - Math.min(12, nonDaemon.length)));
              const nonDaemonQuota = Math.min(nonDaemon.length, 15 - daemonQuota);
              return [...nonDaemon.slice(0, nonDaemonQuota), ...daemon.slice(0, daemonQuota)];
            })()
          : rawMutations.slice(0, 15);

      mdLines.push(`\n### Recent Memory Mutations (Top ${displayMutations.length})`);
      for (const m of displayMutations) {
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

    if (outcomes.length > 0) {
      mdLines.push(`\n### Recent Verified Outcomes (${outcomes.length})`);
      for (const o of outcomes.slice(0, 8)) {
        const failNote = o.failed_attempts
          ? ` | Failed attempts: ${o.failed_attempts.replace(/\s+/g, " ").slice(0, 140)}`
          : "";
        mdLines.push(
          `- **[${o.status.toUpperCase()} | ${o.task_type}]** \`[${o.namespace}]\` ${o.result_summary.replace(/\s+/g, " ").slice(0, 180)}${failNote}`
        );
      }
    }

    mdLines.push(`</overnight_brain_diff>`);

    return {
      windowHours,
      sinceUnix,
      sinceIso,
      summary: {
        totalMutations: totalMutationsCount,
        byOperation,
        byClient,
        byNamespace,
        decisionsAdded: decisions.length,
        episodicEventsLogged: episodicLoggedCount,
        episodicPending: episodicPendingCount,
        conflictsPending: pendingConflicts.length,
        conflictsResolved: resolvedConflicts.length,
        outcomesRecorded: outcomes.length,
        outcomeSuccessRate,
        nextAlarmIso
      },
      conflicts,
      outcomes,
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
   *               + Active Memory Governance & Semantic Contradiction Triage
   */
  async runConsolidationNow(triggerSource = "manual_cli"): Promise<{
    consolidatedCount: number;
    runId: number | null;
    digestMemoryId: string | null;
    digestTitle: string | null;
    digestContent: string | null;
    conflictsDetected: number;
    pendingConflictsCount: number;
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
      // Even when 0 raw episodic logs are pending, run a lightweight contradiction audit on recent mutations
      const auditRes = await this.auditContradictionsNow({ hours: 24, limit: 3 });
      const nextMs = await this.ensureAlarmScheduled();
      return {
        consolidatedCount: 0,
        runId: null,
        digestMemoryId: null,
        digestTitle: null,
        digestContent: null,
        conflictsDetected: auditRes.detectedCount,
        pendingConflictsCount: auditRes.pendingCount,
        nextAlarmIso: new Date(nextMs).toISOString()
      };
    }

    const substantiveRows = rows.filter((r) => !isNoisyProtocolEpisodicRow(r));
    if (substantiveRows.length === 0) {
      // Drain purely noisy legacy handshake rows without creating an empty digest
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE episodic_logs
           SET consolidated = 1
           WHERE log_id IN (SELECT value FROM json_each(?1))`,
          JSON.stringify(rows.map((r) => r.log_id))
        );
      });
      const auditRes = await this.auditContradictionsNow({ hours: 24, limit: 3 });
      const nextMs = await this.ensureAlarmScheduled();
      return {
        consolidatedCount: rows.length,
        runId: null,
        digestMemoryId: null,
        digestTitle: null,
        digestContent: null,
        conflictsDetected: auditRes.detectedCount,
        pendingConflictsCount: auditRes.pendingCount,
        nextAlarmIso: new Date(nextMs).toISOString()
      };
    }

    const formattedLogs = substantiveRows
      .map(
        (r) =>
          `[episodic:${r.log_id}] [${new Date(r.created_at * 1000).toISOString()}] client=${r.client_id} session=${r.session_id} type=${r.event_type}\n${r.payload}`
      )
      .join("\n\n---\n\n");

    const aiResult = (await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
      {
        messages: [
          {
            role: "system",
            content:
              "You are the nocturnal memory consolidation engine for a cross-client engineering brain. " +
              "Your digest is a navigational layer — NOT authoritative truth — and MUST preserve provenance. " +
              "Synthesize the raw episodic logs into structured Markdown with 4 sections:\n" +
              "1. **Summary** (2 concise sentences).\n" +
              "2. **Observed Facts & Architectural Changes** — cite the exact `[episodic:<log_id>]` and UTC date/time for every claim.\n" +
              "3. **Troubleshooting & Failed Attempts** — preserve both failed hypotheses/attempts and verified fixes with `[episodic:<log_id>]` citations.\n" +
              "4. **Uncertainties & Potential Contradictions** — NEVER silently resolve or flatten conflicting claims; explicitly report both sides with their `[episodic:<log_id>]` IDs so the downstream governance auditor can triage them."
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

    const allLogIds = rows.map((r) => r.log_id);
    const substantiveLogIds = substantiveRows.map((r) => r.log_id);
    const filteredNoiseCount = rows.length - substantiveRows.length;
    const uniqueClients = Array.from(new Set(substantiveRows.map((r) => r.client_id)));
    const dateStr = new Date().toISOString().slice(0, 10);
    const windowStartIso = new Date(substantiveRows[0].created_at * 1000).toISOString();
    const windowEndIso = new Date(
      substantiveRows[substantiveRows.length - 1].created_at * 1000
    ).toISOString();

    const digest =
      aiResult?.response?.trim() ||
      `Consolidated ${substantiveRows.length} episodic events (${substantiveLogIds.map((id) => `[episodic:${id}]`).join(", ")}).`;
    const digestTitle = `Daily Consolidated Episodic Digest ${dateStr}`;
    const logIdsQuery = substantiveLogIds.slice(0, 25).join(",");
    const digestSourceUri = `brain://consolidation/${dateStr}?logs=${logIdsQuery}${substantiveLogIds.length > 25 ? `(+${substantiveLogIds.length - 25})` : ""}`;

    // Store nocturnal digest as a navigational summary tier (confidence=0.7) with explicit provenance metadata
    const saved = await this.rememberFact({
      namespace: "global",
      memoryType: "episodic_summary",
      title: digestTitle,
      content: digest,
      sourceUri: digestSourceUri,
      clientId: triggerSource === "alarm_0300" ? "nocturnal-consolidator" : "manual-consolidator",
      importance: 0.72,
      confidence: 0.7,
      metadata: {
        provenance_tier: "llm_digest",
        trigger_source: triggerSource,
        source_log_ids: substantiveLogIds,
        filtered_noise_count: filteredNoiseCount,
        source_clients: uniqueClients,
        observed_window_start: windowStartIso,
        observed_window_end: windowEndIso
      }
    });

    const now = Math.floor(Date.now() / 1000);
    let runId: number | null = null;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE episodic_logs
         SET consolidated = 1
         WHERE log_id IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(allLogIds)
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
          substantiveRows.length,
          JSON.stringify(uniqueClients),
          JSON.stringify(substantiveLogIds),
          digestTitle,
          digest,
          triggerSource,
          now
        )
        .one();
      runId = runRow.run_id;
    });

    // Execute Active Memory Governance & Semantic Contradiction Triage against existing semantic memories/triples/ADRs
    const auditRes = await this.auditContradictionsNow({
      memoryId: saved.id,
      runId,
      hours: 24,
      limit: 4
    });

    const nextMs = await this.ensureAlarmScheduled();
    return {
      consolidatedCount: rows.length,
      runId,
      digestMemoryId: saved.id,
      digestTitle,
      digestContent: digest,
      conflictsDetected: auditRes.detectedCount,
      pendingConflictsCount: auditRes.pendingCount,
      nextAlarmIso: new Date(nextMs).toISOString()
    };
  }

  /**
   * RPC Method 9B: Retrieve Memory Conflicts Queue (Pending or Resolved)
   */
  async getMemoryConflicts(params: GetConflictsParams = {}): Promise<{
    pendingCount: number;
    resolvedCount: number;
    conflicts: MemoryConflictRow[];
  }> {
    const statusFilter = (params.status || "all").toLowerCase();
    const nsFilter = (params.namespace || "").trim();
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));

    const pendingCount = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM memory_conflicts WHERE status = 'pending'`
      )
      .one().count;

    const resolvedCount = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM memory_conflicts WHERE status = 'resolved'`
      )
      .one().count;

    const conflicts = this.sql
      .exec<MemoryConflictRow>(
        `SELECT
           conflict_id, run_id, namespace, conflict_type, severity,
           existing_memory_id, existing_title, existing_snippet, existing_edge_id, existing_decision_id,
           new_memory_id, new_title, new_snippet, new_edge_id,
           reason, suggested_action, merged_content_proposal,
           status, resolution_action, resolved_by, created_at, resolved_at
         FROM memory_conflicts
         WHERE (?1 = 'all' OR status = ?1)
           AND (?2 = '' OR namespace = ?2)
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC, created_at DESC
         LIMIT ?3`,
        statusFilter,
        nsFilter,
        limit
      )
      .toArray();

    return {
      pendingCount,
      resolvedCount,
      conflicts
    };
  }

  /**
   * RPC Method 9C: Active Memory Governance & Semantic Contradiction Auditor
   *                Compares newly consolidated digests or recent facts against existing active memories,
   *                Knowledge Graph triples, and ADRs using deterministic KG checks + Llama 3.3 70B triage.
   */
  async auditContradictionsNow(params: AuditContradictionsParams = {}): Promise<{
    ok: boolean;
    auditedMemoriesCount: number;
    detectedCount: number;
    pendingCount: number;
    newConflicts: MemoryConflictRow[];
    pendingConflicts: MemoryConflictRow[];
  }> {
    const now = Math.floor(Date.now() / 1000);
    const hours = Math.max(1, Math.min(720, params.hours ?? 24));
    const sinceUnix = now - Math.floor(hours * 3600);
    const nsFilter = (params.namespace || "").trim();
    const limit = Math.max(1, Math.min(10, params.limit ?? 4));
    const runId = params.runId ?? null;
    const newlyInsertedIds: number[] = [];

    // Stage 1: Deterministic Knowledge Graph Triple Contradiction Check across active edges
    const duplicateRelationGroups = this.sql
      .exec<{
        source_entity: string;
        relation: string;
        cnt: number;
      }>(
        `SELECT source_entity, relation, COUNT(*) AS cnt
         FROM edges
         WHERE valid_until IS NULL
         GROUP BY source_entity, relation
         HAVING COUNT(*) > 1`
      )
      .toArray();

    for (const grp of duplicateRelationGroups) {
      if (!FUNCTIONAL_RELATIONS.has(grp.relation.trim().toUpperCase())) continue;
      if (isProtectedInfrastructure(grp.source_entity)) continue;

      const edgeRows = this.sql
        .exec<{
          edge_id: string;
          namespace: string;
          target_entity: string;
          evidence_memory_id: string | null;
          valid_from: number;
        }>(
          `SELECT edge_id, namespace, target_entity, evidence_memory_id, valid_from
           FROM edges
           WHERE source_entity = ?1
             AND relation = ?2
             AND valid_until IS NULL
           ORDER BY valid_from DESC`,
          grp.source_entity,
          grp.relation
        )
        .toArray();

      if (edgeRows.length < 2) continue;
      const newestEdge = edgeRows[0];
      for (let i = 1; i < edgeRows.length; i++) {
        const olderEdge = edgeRows[i];
        if (isProtectedInfrastructure(olderEdge.edge_id)) continue;
        if (olderEdge.target_entity === newestEdge.target_entity) continue;

        const exists = this.sql
          .exec<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt
             FROM memory_conflicts
             WHERE existing_edge_id = ?1
               AND new_edge_id = ?2`,
            olderEdge.edge_id,
            newestEdge.edge_id
          )
          .one().cnt;

        if (exists === 0) {
          const ins = this.sql
            .exec<{ conflict_id: number }>(
              `INSERT INTO memory_conflicts (
                 run_id, namespace, conflict_type, severity,
                 existing_memory_id, existing_title, existing_snippet, existing_edge_id,
                 new_memory_id, new_title, new_snippet, new_edge_id,
                 reason, suggested_action, merged_content_proposal, status, created_at
               ) VALUES (
                 ?1, ?2, 'triple_conflict', 'medium',
                 ?3, ?4, ?5, ?6,
                 ?7, ?8, ?9, ?10,
                 ?11, 'supersede', NULL, 'pending', ?12
               )
               RETURNING conflict_id`,
              runId,
              newestEdge.namespace || "global",
              olderEdge.evidence_memory_id,
              olderEdge.edge_id,
              `Active KG Triple: ${grp.source_entity} -[${grp.relation}]-> ${olderEdge.target_entity}`,
              olderEdge.edge_id,
              newestEdge.evidence_memory_id,
              newestEdge.edge_id,
              `New KG Triple: ${grp.source_entity} -[${grp.relation}]-> ${newestEdge.target_entity}`,
              newestEdge.edge_id,
              `Single-valued relation '${grp.relation}' on '${grp.source_entity}' has conflicting active targets: '${olderEdge.target_entity}' vs '${newestEdge.target_entity}'.`,
              now
            )
            .one();
          newlyInsertedIds.push(ins.conflict_id);
        }
      }
    }

    // Stage 2: LLM Semantic Contradiction Check comparing recent/target memories against older active memories & ADRs
    const targetMemories = params.memoryId
      ? this.sql
          .exec<{
            id: string;
            namespace: string;
            memory_type: string;
            title: string;
            content: string;
            summary: string | null;
            updated_at: number;
          }>(
            `SELECT id, namespace, memory_type, title, content, summary, updated_at
             FROM memories
             WHERE id = ?1
               AND superseded_by IS NULL`,
            params.memoryId
          )
          .toArray()
      : this.sql
          .exec<{
            id: string;
            namespace: string;
            memory_type: string;
            title: string;
            content: string;
            summary: string | null;
            updated_at: number;
          }>(
            `SELECT id, namespace, memory_type, title, content, summary, updated_at
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

    for (const newMem of targetMemories) {
      const ftsQuery = buildSafeFts5Query(`${newMem.title} ${(newMem.summary || newMem.content).slice(0, 260)}`);
      if (ftsQuery === '""') continue;

      const candidateOlderMemories = this.sql
        .exec<
          MemoryRecord & {
            raw_bm25: number;
            recency_decay: number;
            lexical_rank: number;
          }
        >(LEXICAL_HYBRID_SQL, ftsQuery, newMem.namespace, now, 30 * 86400, 10)
        .toArray()
        .filter(
          (m) =>
            m.id !== newMem.id &&
            !isProtectedInfrastructure(m.id) &&
            !isProtectedInfrastructure(m.title)
        )
        .slice(0, 6);

      const candidateAdrs = this.sql
        .exec<ActiveDecisionRow>(
          `SELECT decision_id, namespace, title, decision, rationale, created_at
           FROM decisions
           WHERE (?1 = 'global' OR namespace = ?1 OR namespace = 'global')
             AND status = 'active'
           ORDER BY created_at DESC
           LIMIT 6`,
          newMem.namespace
        )
        .toArray();

      if (candidateOlderMemories.length === 0 && candidateAdrs.length === 0) {
        continue;
      }

      const existingBlock = candidateOlderMemories
        .map(
          (m) =>
            `[EXISTING_MEMORY id="${m.id}" namespace="${m.namespace}" updated_at="${new Date(m.updated_at * 1000).toISOString().slice(0, 10)}"]\nTitle: ${m.title}\nContent: ${m.content.slice(0, 700)}`
        )
        .join("\n\n");

      const adrBlock = candidateAdrs
        .map(
          (a) =>
            `[EXISTING_ADR decision_id="${a.decision_id}" namespace="${a.namespace || "global"}"]\nTitle: ${a.title}\nDecision: ${a.decision}`
        )
        .join("\n\n");

      try {
        const aiRes = (await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
          {
            messages: [
              {
                role: "system",
                content:
                  "You are an Active Memory Governance Auditor for a software architect's knowledge base. " +
                  "Compare the NEW_MEMORY against the EXISTING_MEMORY and EXISTING_ADR records. " +
                  "Identify ONLY direct factual, architectural, port, version, model, status, or configuration contradictions where an older record is now outdated, superseded, or conflicting. " +
                  "Do NOT flag complementary or additive facts that merely expand on a topic. " +
                  "Never flag or deprecate Raspberry Pi 5 (node:rpi5) or Qdrant (service:rpi5-qdrant-knowledge-hub) active graph state. " +
                  "Respond ONLY with a valid JSON array (or [] if no contradictions exist). Each element must follow:\n" +
                  '[{"conflictType":"semantic_contradiction"|"adr_drift","severity":"low"|"medium"|"high","existingMemoryId":"string or null","existingDecisionId":"string or null","reason":"concise 1-sentence explanation of the contradiction","suggestedAction":"keep"|"supersede"|"merge","mergedContentProposal":"optional combined Markdown if suggestedAction is merge"}]'
              },
              {
                role: "user",
                content:
                  `=== NEW_MEMORY (id="${newMem.id}", namespace="${newMem.namespace}", title="${newMem.title}") ===\n` +
                  `${newMem.content.slice(0, 1500)}\n\n` +
                  `=== CANDIDATE EXISTING MEMORIES ===\n${existingBlock || "(none)"}\n\n` +
                  `=== CANDIDATE EXISTING ADRS ===\n${adrBlock || "(none)"}`
              }
            ],
            max_tokens: 700,
            temperature: 0.1
          } as never
        )) as unknown as { response?: string };

        const rawText = (aiRes?.response || "").trim();
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) continue;

        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          conflictType?: string;
          severity?: string;
          existingMemoryId?: string | null;
          existingDecisionId?: string | null;
          reason?: string;
          suggestedAction?: string;
          mergedContentProposal?: string | null;
        }>;

        if (!Array.isArray(parsed)) continue;

        for (const item of parsed) {
          const oldMemId = item.existingMemoryId?.trim() || null;
          const oldAdrId = item.existingDecisionId?.trim() || null;
          if (!oldMemId && !oldAdrId) continue;
          if (oldMemId === newMem.id) continue;
          if (isProtectedInfrastructure(oldMemId)) continue;

          const matchedOldMem = oldMemId
            ? candidateOlderMemories.find((m) => m.id === oldMemId)
            : undefined;
          const matchedOldAdr = oldAdrId
            ? candidateAdrs.find((a) => a.decision_id === oldAdrId)
            : undefined;

          if (!matchedOldMem && !matchedOldAdr) continue;

          // Ensure we don't duplicate an already-logged conflict for the same pair
          const dupCount = this.sql
            .exec<{ cnt: number }>(
              `SELECT COUNT(*) AS cnt
               FROM memory_conflicts
               WHERE COALESCE(existing_memory_id, '') = ?1
                 AND COALESCE(existing_decision_id, '') = ?2
                 AND COALESCE(new_memory_id, '') = ?3`,
              oldMemId || "",
              oldAdrId || "",
              newMem.id
            )
            .one().cnt;

          if (dupCount > 0) continue;

          const cType =
            item.conflictType === "adr_drift" || matchedOldAdr
              ? "adr_drift"
              : "semantic_contradiction";
          const sev =
            item.severity === "high" || item.severity === "low" ? item.severity : "medium";
          const action =
            item.suggestedAction === "keep" || item.suggestedAction === "merge"
              ? item.suggestedAction
              : "supersede";

          const ins = this.sql
            .exec<{ conflict_id: number }>(
              `INSERT INTO memory_conflicts (
                 run_id, namespace, conflict_type, severity,
                 existing_memory_id, existing_title, existing_snippet, existing_edge_id, existing_decision_id,
                 new_memory_id, new_title, new_snippet, new_edge_id,
                 reason, suggested_action, merged_content_proposal, status, created_at
               ) VALUES (
                 ?1, ?2, ?3, ?4,
                 ?5, ?6, ?7, NULL, ?8,
                 ?9, ?10, ?11, NULL,
                 ?12, ?13, ?14, 'pending', ?15
               )
               RETURNING conflict_id`,
              runId,
              matchedOldMem?.namespace || matchedOldAdr?.namespace || newMem.namespace,
              cType,
              sev,
              matchedOldMem?.id || null,
              matchedOldMem?.title || matchedOldAdr?.title || null,
              (matchedOldMem?.summary || matchedOldMem?.content || matchedOldAdr?.decision || "").slice(0, 280),
              matchedOldAdr?.decision_id || null,
              newMem.id,
              newMem.title,
              (newMem.summary || newMem.content).slice(0, 280),
              (item.reason || "Semantic contradiction detected during consolidation audit.").slice(0, 500),
              action,
              item.mergedContentProposal || null,
              now
            )
            .one();
          newlyInsertedIds.push(ins.conflict_id);
        }
      } catch {
        // Non-fatal if LLM response is non-JSON or times out
      }
    }

    const currentQueue = await this.getMemoryConflicts({ status: "pending", limit: 50 });
    const newConflicts = currentQueue.conflicts.filter((c) =>
      newlyInsertedIds.includes(c.conflict_id)
    );

    return {
      ok: true,
      auditedMemoriesCount: targetMemories.length,
      detectedCount: newlyInsertedIds.length,
      pendingCount: currentQueue.pendingCount,
      newConflicts,
      pendingConflicts: currentQueue.conflicts
    };
  }

  /**
   * RPC Method 9D: Resolve a Flagged Memory Conflict (15-second keep / supersede / merge decision)
   */
  async resolveMemoryConflict(params: ResolveConflictParams): Promise<{
    ok: boolean;
    conflictId: number;
    action?: "keep" | "supersede" | "merge";
    supersededMemoryId?: string | null;
    supersededEdgeId?: string | null;
    supersededDecisionId?: string | null;
    mergedMemoryId?: string | null;
    vectorDeleted?: boolean;
    mutationId?: number;
    error?: string;
  }> {
    const conflictId = Number(params.conflictId);
    const action = params.action;
    const clientId = (params.clientId || "cli-morning-triage").trim();

    if (!conflictId || !["keep", "supersede", "merge"].includes(action)) {
      return {
        ok: false,
        conflictId,
        error: "Valid conflictId and action ('keep' | 'supersede' | 'merge') are required."
      };
    }

    const rows = this.sql
      .exec<MemoryConflictRow>(
        `SELECT
           conflict_id, run_id, namespace, conflict_type, severity,
           existing_memory_id, existing_title, existing_snippet, existing_edge_id, existing_decision_id,
           new_memory_id, new_title, new_snippet, new_edge_id,
           reason, suggested_action, merged_content_proposal,
           status, resolution_action, resolved_by, created_at, resolved_at
         FROM memory_conflicts
         WHERE conflict_id = ?1`,
        conflictId
      )
      .toArray();

    const conflict = rows[0];
    if (!conflict) {
      return {
        ok: false,
        conflictId,
        error: `Conflict #${conflictId} not found.`
      };
    }

    const now = Math.floor(Date.now() / 1000);

    // Action 1: KEEP (Keep existing memory/triple/ADR authoritative; dismiss conflict)
    if (action === "keep") {
      this.sql.exec(
        `UPDATE memory_conflicts
         SET status = 'resolved',
             resolution_action = 'keep',
             resolved_by = ?1,
             resolved_at = ?2
         WHERE conflict_id = ?3`,
        clientId,
        now,
        conflictId
      );

      return {
        ok: true,
        conflictId,
        action: "keep"
      };
    }

    // Action 2: SUPERSEDE (Deprecate old memory/triple/ADR in favor of the new record & clean Vectorize)
    if (action === "supersede") {
      if (
        isProtectedInfrastructure(conflict.existing_memory_id) ||
        isProtectedInfrastructure(conflict.existing_edge_id)
      ) {
        return {
          ok: false,
          conflictId,
          error:
            "Safety Guardrail: Raspberry Pi 5 (node:rpi5) and Qdrant (service:rpi5-qdrant-knowledge-hub) records are protected and cannot be superseded."
        };
      }

      let mutationId: number | undefined;
      let vectorDeleted = false;

      this.ctx.storage.transactionSync(() => {
        if (conflict.existing_memory_id) {
          const oldMem = this.sql
            .exec<{
              id: string;
              namespace: string;
              memory_type: string;
              title: string;
              content: string;
              summary: string | null;
              importance: number;
              source_uri: string | null;
            }>(
              `SELECT id, namespace, memory_type, title, content, summary, importance, source_uri
               FROM memories
               WHERE id = ?1`,
              conflict.existing_memory_id
            )
            .toArray()[0];

          const targetNewId = conflict.new_memory_id || conflict.existing_memory_id;
          this.sql.exec(
            `UPDATE memories
             SET superseded_by = ?1,
                 updated_at = ?2
             WHERE id = ?3`,
            targetNewId,
            now,
            conflict.existing_memory_id
          );

          if (oldMem) {
            const mutRow = this.sql
              .exec<{ mutation_id: number }>(
                `INSERT INTO memory_mutations (
                   memory_id, namespace, memory_type, operation, client_id,
                   old_title, old_content, old_summary, old_importance,
                   new_title, new_content, new_summary, new_importance,
                   source_uri, rolled_back, created_at
                 ) VALUES (?1, ?2, ?3, 'DELETE', ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, 0, ?13)
                 RETURNING mutation_id`,
                oldMem.id,
                oldMem.namespace,
                oldMem.memory_type,
                clientId,
                oldMem.title,
                oldMem.content,
                oldMem.summary,
                oldMem.importance,
                `[SUPERSEDED BY ${targetNewId}] ${oldMem.title}`,
                `Superseded via Conflict #${conflictId}: ${conflict.reason}`,
                oldMem.importance,
                oldMem.source_uri,
                now
              )
              .one();
            mutationId = mutRow.mutation_id;
          }
        }

        if (conflict.existing_edge_id && !isProtectedInfrastructure(conflict.existing_edge_id)) {
          this.sql.exec(
            `UPDATE edges
             SET valid_until = ?1
             WHERE edge_id = ?2`,
            now,
            conflict.existing_edge_id
          );
        }

        if (conflict.existing_decision_id) {
          this.sql.exec(
            `UPDATE decisions
             SET status = 'superseded'
             WHERE decision_id = ?1`,
            conflict.existing_decision_id
          );
        }

        this.sql.exec(
          `UPDATE memory_conflicts
           SET status = 'resolved',
               resolution_action = 'supersede',
               resolved_by = ?1,
               resolved_at = ?2
           WHERE conflict_id = ?3`,
          clientId,
          now,
          conflictId
        );
      });

      if (conflict.existing_memory_id) {
        try {
          await this.env.VECTOR_INDEX.deleteByIds([conflict.existing_memory_id]);
          vectorDeleted = true;
        } catch {
          vectorDeleted = false;
        }
      }

      return {
        ok: true,
        conflictId,
        action: "supersede",
        supersededMemoryId: conflict.existing_memory_id,
        supersededEdgeId: conflict.existing_edge_id,
        supersededDecisionId: conflict.existing_decision_id,
        vectorDeleted,
        mutationId
      };
    }

    // Action 3: MERGE (Synthesize existing + new into an updated authoritative memory & re-embed)
    const targetMemoryId = conflict.existing_memory_id || conflict.new_memory_id;
    if (!targetMemoryId) {
      return {
        ok: false,
        conflictId,
        error: `Conflict #${conflictId} has no memory ID to merge.`
      };
    }

    const existingMem = conflict.existing_memory_id
      ? this.sql
          .exec<{
            id: string;
            namespace: string;
            memory_type: "semantic" | "procedural" | "episodic_summary";
            title: string;
            content: string;
            importance: number;
            source_uri: string | null;
          }>(
            `SELECT id, namespace, memory_type, title, content, importance, source_uri
             FROM memories
             WHERE id = ?1`,
            conflict.existing_memory_id
          )
          .toArray()[0]
      : undefined;

    const newMem = conflict.new_memory_id
      ? this.sql
          .exec<{
            id: string;
            namespace: string;
            memory_type: "semantic" | "procedural" | "episodic_summary";
            title: string;
            content: string;
            importance: number;
          }>(
            `SELECT id, namespace, memory_type, title, content, importance
             FROM memories
             WHERE id = ?1`,
            conflict.new_memory_id
          )
          .toArray()[0]
      : undefined;

    const mergedText =
      params.mergedContent?.trim() ||
      conflict.merged_content_proposal?.trim() ||
      [
        existingMem?.content || conflict.existing_snippet || "",
        `\n\n### Consolidated Governance Update (${new Date(now * 1000).toISOString().slice(0, 10)})`,
        `- **Triage Resolution (Conflict #${conflictId})**: ${conflict.reason}`,
        newMem?.content || conflict.new_snippet || ""
      ]
        .filter(Boolean)
        .join("\n");

    const upserted = await this.rememberFact({
      id: targetMemoryId,
      namespace: existingMem?.namespace || conflict.namespace || "global",
      memoryType: existingMem?.memory_type || "semantic",
      title: existingMem?.title || conflict.existing_title || conflict.new_title || targetMemoryId,
      content: mergedText,
      sourceUri: existingMem?.source_uri || undefined,
      clientId,
      importance: Math.max(existingMem?.importance ?? 0.7, newMem?.importance ?? 0.7)
    });

    // If new_memory_id was a standalone non-digest semantic memory distinct from existing_memory_id, mark it superseded
    let secondaryVectorDeleted = false;
    if (
      conflict.existing_memory_id &&
      conflict.new_memory_id &&
      conflict.new_memory_id !== conflict.existing_memory_id &&
      newMem &&
      newMem.memory_type !== "episodic_summary" &&
      !isProtectedInfrastructure(conflict.new_memory_id)
    ) {
      this.sql.exec(
        `UPDATE memories SET superseded_by = ?1, updated_at = ?2 WHERE id = ?3`,
        conflict.existing_memory_id,
        now,
        conflict.new_memory_id
      );
      try {
        await this.env.VECTOR_INDEX.deleteByIds([conflict.new_memory_id]);
        secondaryVectorDeleted = true;
      } catch {
        secondaryVectorDeleted = false;
      }
    }

    this.sql.exec(
      `UPDATE memory_conflicts
       SET status = 'resolved',
           resolution_action = 'merge',
           resolved_by = ?1,
           resolved_at = ?2
       WHERE conflict_id = ?3`,
      clientId,
      now,
      conflictId
    );

    return {
      ok: true,
      conflictId,
      action: "merge",
      mergedMemoryId: upserted.id,
      vectorDeleted: secondaryVectorDeleted,
      mutationId: upserted.mutationId
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
    restoredEdgesCount?: number;
    retiredEdgesCount?: number;
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
               AND operation IN ('UPDATE', 'INSERT', 'CONSOLIDATE', 'DELETE')
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

    // Case A: Mutation had a prior version (UPDATE or SUPERSEDE/DELETE) -> restore old_title + old_content + un-supersede
    if (target.old_content !== null) {
      const restoredTitle = target.old_title || target.new_title || target.memory_id;
      const restoredContent = target.old_content;
      const restoredSummary =
        target.old_summary ||
        (restoredContent.length > 280 ? `${restoredContent.slice(0, 277)}...` : restoredContent);
      const restoredImportance = target.old_importance ?? 0.6;
      const tokenCount = estimateTokens(`${restoredTitle}\n${restoredContent}`);
      let restoredEdgesCount = 0;

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE memories
           SET title = ?1,
               content = ?2,
               summary = ?3,
               importance = ?4,
               token_count = ?5,
               superseded_by = NULL,
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

        // If rolling back a supersede/DELETE mutation, also restore KG edges expired in that exact transaction
        if (target.operation === "DELETE") {
          const edgesToRestore = this.sql
            .exec<{ edge_id: string }>(
              `SELECT edge_id
               FROM edges
               WHERE valid_until = ?1
                 AND (
                   evidence_memory_id = ?2
                   OR edge_id IN (
                     SELECT existing_edge_id
                     FROM memory_conflicts
                     WHERE existing_memory_id = ?2
                       AND resolution_action = 'supersede'
                       AND resolved_at = ?1
                       AND existing_edge_id IS NOT NULL
                   )
                 )`,
              target.created_at,
              target.memory_id
            )
            .toArray();

          if (edgesToRestore.length > 0) {
            this.sql.exec(
              `UPDATE edges
               SET valid_until = NULL
               WHERE edge_id IN (SELECT value FROM json_each(?1))`,
              JSON.stringify(edgesToRestore.map((e) => e.edge_id))
            );
            restoredEdgesCount = edgesToRestore.length;
          }
        }

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
        vectorSynced: Boolean(vec),
        restoredEdgesCount
      };
    }

    // Case B: Mutation was an INSERT/CONSOLIDATE with no previous version -> retire linked non-protected edges & delete memory + vector
    let retiredEdgesCount = 0;
    this.ctx.storage.transactionSync(() => {
      const linkedEdges = this.sql
        .exec<{ edge_id: string }>(
          `SELECT edge_id
           FROM edges
           WHERE evidence_memory_id = ?1
             AND valid_until IS NULL`,
          target.memory_id
        )
        .toArray()
        .filter((e) => !isProtectedInfrastructure(e.edge_id));

      if (linkedEdges.length > 0) {
        this.sql.exec(
          `UPDATE edges
           SET valid_until = ?1
           WHERE edge_id IN (SELECT value FROM json_each(?2))`,
          now,
          JSON.stringify(linkedEdges.map((e) => e.edge_id))
        );
        retiredEdgesCount = linkedEdges.length;
      }

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
      vectorSynced: true,
      retiredEdgesCount
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

    const embeddedVectors = await this.embedTexts(
      rows.map((r) => `${r.title.slice(0, 300)}\n${r.content.slice(0, 3500)}`)
    );

    const vectors: VectorizeVector[] = [];
    rows.forEach((r, idx) => {
      const vec = embeddedVectors[idx];
      if (vec) {
        vectors.push({
          id: r.id,
          values: vec,
          namespace: r.namespace,
          metadata: {
            namespace: r.namespace,
            title: r.title.slice(0, 500),
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
   * RPC Method 11B: Deep Cross-Layer Text Scan & Replace across ALL BrainMemoryDO SQLite tables,
   * Knowledge Graph entities/edges (with FK-safe entity merge), FTS5 rebuild, and Vectorize re-embedding.
   */
  async replaceTextAcrossLayers(params: ReplaceTextAcrossLayersParams): Promise<{
    ok: boolean;
    dryRun: boolean;
    tables: Record<string, { scanned: number; matchedRows: number; updatedRows: number }>;
    modifiedMemoryIds: string[];
    reindexedVectors: number;
    ftsRebuilt: boolean;
    samples: TextReplaceSample[];
  }> {
    if (!Array.isArray(params.rules) || params.rules.length === 0) {
      throw new Error("replaceTextAcrossLayers requires at least one replacement rule.");
    }

    const compiledRules = params.rules.map((r) => {
      if (!r || typeof r.pattern !== "string" || !r.pattern) {
        throw new Error("Each replacement rule must have a non-empty 'pattern'.");
      }
      const rawFlags = typeof r.flags === "string" ? r.flags : "gi";
      const flags = rawFlags.includes("g") ? rawFlags : `${rawFlags}g`;
      return {
        regex: new RegExp(r.pattern, flags),
        replacement: typeof r.replacement === "string" ? r.replacement : ""
      };
    });

    const dryRun = params.dryRun !== false;
    const reindexVectors = params.reindexVectors !== false;
    const includeSourceUri = params.includeSourceUri === true;
    const maxSamplesPerTable = Math.max(5, Math.min(500, params.maxSamplesPerTable ?? 80));
    const now = Math.floor(Date.now() / 1000);

    const applyRules = (val: string | null | undefined): string | null => {
      if (val === null || val === undefined) return null;
      let out = val;
      for (const rule of compiledRules) {
        rule.regex.lastIndex = 0;
        out = out.replace(rule.regex, rule.replacement);
      }
      return out;
    };

    const samples: TextReplaceSample[] = [];
    const tableSampleCounts: Record<string, number> = {};
    const recordSample = (
      table: string,
      rowId: string,
      column: string,
      before: string,
      after: string
    ) => {
      const cnt = tableSampleCounts[table] ?? 0;
      if (cnt >= maxSamplesPerTable) return;
      // Extract compact context around first difference
      let diffIdx = 0;
      const minLen = Math.min(before.length, after.length);
      while (diffIdx < minLen && before[diffIdx] === after[diffIdx]) diffIdx++;
      const start = Math.max(0, diffIdx - 45);
      const beforeSnip = before.slice(start, start + 180).replace(/\s+/g, " ");
      const afterSnip = after.slice(start, start + 180).replace(/\s+/g, " ");
      samples.push({ table, rowId, column, before: beforeSnip, after: afterSnip });
      tableSampleCounts[table] = cnt + 1;
    };

    const tables: Record<string, { scanned: number; matchedRows: number; updatedRows: number }> = {
      memories: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      entities: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      edges: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      decisions: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      episodic_logs: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      memory_mutations: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      consolidation_runs: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      memory_conflicts: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      outcomes: { scanned: 0, matchedRows: 0, updatedRows: 0 },
      memory_validations: { scanned: 0, matchedRows: 0, updatedRows: 0 }
    };

    const modifiedActiveMemoryIds: string[] = [];
    const modifiedAllMemoryIds: string[] = [];

    const executePass = () => {
      // 1. memories
      const memRows = this.sql
        .exec<{
          id: string;
          title: string;
          content: string;
          summary: string | null;
          source_uri: string | null;
          metadata_json: string | null;
          superseded_by: string | null;
        }>(
          `SELECT id, title, content, summary, source_uri, metadata_json, superseded_by FROM memories`
        )
        .toArray();
      tables.memories.scanned = memRows.length;
      for (const row of memRows) {
        const nextTitle = applyRules(row.title) ?? row.title;
        const nextContent = applyRules(row.content) ?? row.content;
        const nextSummary = applyRules(row.summary);
        const nextSourceUri = includeSourceUri ? applyRules(row.source_uri) : row.source_uri;
        const nextMeta = applyRules(row.metadata_json);

        let changed = false;
        if (nextTitle !== row.title) {
          changed = true;
          recordSample("memories", row.id, "title", row.title, nextTitle);
        }
        if (nextContent !== row.content) {
          changed = true;
          recordSample("memories", row.id, "content", row.content, nextContent);
        }
        if (nextSummary !== row.summary && row.summary !== null && nextSummary !== null) {
          changed = true;
          recordSample("memories", row.id, "summary", row.summary, nextSummary);
        }
        if (nextSourceUri !== row.source_uri && row.source_uri !== null && nextSourceUri !== null) {
          changed = true;
          recordSample("memories", row.id, "source_uri", row.source_uri, nextSourceUri);
        }
        if (nextMeta !== row.metadata_json && row.metadata_json !== null && nextMeta !== null) {
          changed = true;
          recordSample("memories", row.id, "metadata_json", row.metadata_json, nextMeta);
        }

        if (changed) {
          tables.memories.matchedRows++;
          modifiedAllMemoryIds.push(row.id);
          if (row.superseded_by === null) {
            modifiedActiveMemoryIds.push(row.id);
          }
          if (!dryRun) {
            const nextTokens = estimateTokens(`${nextTitle}\n${nextContent}`);
            this.sql.exec(
              `UPDATE memories
               SET title = ?1, content = ?2, summary = ?3, source_uri = ?4, metadata_json = ?5,
                   token_count = ?6, updated_at = ?7
               WHERE id = ?8`,
              nextTitle,
              nextContent,
              nextSummary,
              nextSourceUri,
              nextMeta,
              nextTokens,
              now,
              row.id
            );
            tables.memories.updatedRows++;
          }
        }
      }

      // 2. entities (+ FK-safe edges repoint/merge)
      const entityRows = this.sql
        .exec<{
          entity_id: string;
          namespace: string;
          entity_type: string;
          canonical_name: string;
          description: string | null;
          pagerank_score: number;
          attributes_json: string | null;
        }>(
          `SELECT entity_id, namespace, entity_type, canonical_name, description, pagerank_score, attributes_json FROM entities`
        )
        .toArray();
      tables.entities.scanned = entityRows.length;
      const renamedEntities = new Map<string, string>();
      for (const row of entityRows) {
        if (isProtectedInfrastructure(row.entity_id)) continue;
        const rawNextId = applyRules(row.entity_id) ?? row.entity_id;
        const nextEntityId = rawNextId !== row.entity_id ? rawNextId.toLowerCase() : row.entity_id;
        const nextName = applyRules(row.canonical_name) ?? row.canonical_name;
        const nextDesc = applyRules(row.description);
        const nextAttrs = applyRules(row.attributes_json);

        let changed = false;
        if (nextEntityId !== row.entity_id) {
          changed = true;
          recordSample("entities", row.entity_id, "entity_id", row.entity_id, nextEntityId);
        }
        if (nextName !== row.canonical_name) {
          changed = true;
          recordSample("entities", row.entity_id, "canonical_name", row.canonical_name, nextName);
        }
        if (nextDesc !== row.description && row.description !== null && nextDesc !== null) {
          changed = true;
          recordSample("entities", row.entity_id, "description", row.description, nextDesc);
        }
        if (nextAttrs !== row.attributes_json && row.attributes_json !== null && nextAttrs !== null) {
          changed = true;
          recordSample("entities", row.entity_id, "attributes_json", row.attributes_json, nextAttrs);
        }

        if (changed) {
          tables.entities.matchedRows++;
          if (nextEntityId !== row.entity_id) {
            renamedEntities.set(row.entity_id, nextEntityId);
          }
          if (!dryRun) {
            if (nextEntityId === row.entity_id) {
              this.sql.exec(
                `UPDATE entities
                 SET canonical_name = ?1, description = ?2, attributes_json = ?3, updated_at = ?4
                 WHERE entity_id = ?5`,
                nextName,
                nextDesc,
                nextAttrs,
                now,
                row.entity_id
              );
            } else {
              this.sql.exec(
                `INSERT INTO entities (entity_id, namespace, entity_type, canonical_name, description, pagerank_score, attributes_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(entity_id) DO UPDATE SET
                   pagerank_score = MAX(entities.pagerank_score, excluded.pagerank_score),
                   updated_at = excluded.updated_at`,
                nextEntityId,
                row.namespace,
                row.entity_type,
                nextName,
                nextDesc,
                row.pagerank_score,
                nextAttrs ?? "{}",
                now
              );
            }
            tables.entities.updatedRows++;
          }
        }
      }

      // 3. edges
      const edgeRows = this.sql
        .exec<{
          edge_id: string;
          namespace: string;
          source_entity: string;
          relation: string;
          target_entity: string;
          weight: number;
          evidence_memory_id: string | null;
          valid_from: number;
          valid_until: number | null;
        }>(
          `SELECT edge_id, namespace, source_entity, relation, target_entity, weight, evidence_memory_id, valid_from, valid_until FROM edges`
        )
        .toArray();
      tables.edges.scanned = edgeRows.length;
      for (const row of edgeRows) {
        const nextSource = renamedEntities.get(row.source_entity) ?? row.source_entity;
        const nextTarget = renamedEntities.get(row.target_entity) ?? row.target_entity;
        const nextRelation = applyRules(row.relation) ?? row.relation;
        const nextEdgeId = `${nextSource}|${nextRelation}|${nextTarget}`;

        if (
          nextSource !== row.source_entity ||
          nextTarget !== row.target_entity ||
          nextRelation !== row.relation ||
          nextEdgeId !== row.edge_id
        ) {
          tables.edges.matchedRows++;
          recordSample("edges", row.edge_id, "edge_id", row.edge_id, nextEdgeId);
          if (!dryRun) {
            const existsTarget = this.sql
              .exec<{ edge_id: string; valid_until: number | null }>(
                `SELECT edge_id, valid_until FROM edges WHERE edge_id = ?1`,
                nextEdgeId
              )
              .toArray()[0];
            if (existsTarget && nextEdgeId !== row.edge_id) {
              if (row.valid_until === null && existsTarget.valid_until !== null) {
                this.sql.exec(
                  `UPDATE edges SET valid_until = NULL WHERE edge_id = ?1`,
                  nextEdgeId
                );
              }
              this.sql.exec(`DELETE FROM edges WHERE edge_id = ?1`, row.edge_id);
            } else {
              this.sql.exec(
                `UPDATE edges
                 SET edge_id = ?1, source_entity = ?2, relation = ?3, target_entity = ?4
                 WHERE edge_id = ?5`,
                nextEdgeId,
                nextSource,
                nextRelation,
                nextTarget,
                row.edge_id
              );
            }
            tables.edges.updatedRows++;
          }
        }
      }

      if (!dryRun && renamedEntities.size > 0) {
        for (const oldId of renamedEntities.keys()) {
          this.sql.exec(`DELETE FROM entities WHERE entity_id = ?1`, oldId);
        }
      }

      // 4. decisions
      const decRows = this.sql
        .exec<{ decision_id: string; title: string; decision: string; rationale: string }>(
          `SELECT decision_id, title, decision, rationale FROM decisions`
        )
        .toArray();
      tables.decisions.scanned = decRows.length;
      for (const row of decRows) {
        const nextTitle = applyRules(row.title) ?? row.title;
        const nextDec = applyRules(row.decision) ?? row.decision;
        const nextRat = applyRules(row.rationale) ?? row.rationale;
        if (nextTitle !== row.title || nextDec !== row.decision || nextRat !== row.rationale) {
          tables.decisions.matchedRows++;
          if (nextTitle !== row.title) recordSample("decisions", row.decision_id, "title", row.title, nextTitle);
          if (nextDec !== row.decision) recordSample("decisions", row.decision_id, "decision", row.decision, nextDec);
          if (nextRat !== row.rationale) recordSample("decisions", row.decision_id, "rationale", row.rationale, nextRat);
          if (!dryRun) {
            this.sql.exec(
              `UPDATE decisions SET title = ?1, decision = ?2, rationale = ?3 WHERE decision_id = ?4`,
              nextTitle,
              nextDec,
              nextRat,
              row.decision_id
            );
            tables.decisions.updatedRows++;
          }
        }
      }

      // 5. episodic_logs
      const epRows = this.sql
        .exec<{ log_id: number; payload: string }>(`SELECT log_id, payload FROM episodic_logs`)
        .toArray();
      tables.episodic_logs.scanned = epRows.length;
      for (const row of epRows) {
        const nextPayload = applyRules(row.payload) ?? row.payload;
        if (nextPayload !== row.payload) {
          tables.episodic_logs.matchedRows++;
          recordSample("episodic_logs", String(row.log_id), "payload", row.payload, nextPayload);
          if (!dryRun) {
            this.sql.exec(
              `UPDATE episodic_logs SET payload = ?1 WHERE log_id = ?2`,
              nextPayload,
              row.log_id
            );
            tables.episodic_logs.updatedRows++;
          }
        }
      }

      // 6. memory_mutations
      const mutRows = this.sql
        .exec<{
          mutation_id: number;
          old_title: string | null;
          old_content: string | null;
          old_summary: string | null;
          new_title: string | null;
          new_content: string | null;
          new_summary: string | null;
          source_uri: string | null;
        }>(
          `SELECT mutation_id, old_title, old_content, old_summary, new_title, new_content, new_summary, source_uri FROM memory_mutations`
        )
        .toArray();
      tables.memory_mutations.scanned = mutRows.length;
      for (const row of mutRows) {
        const nOldTitle = applyRules(row.old_title);
        const nOldContent = applyRules(row.old_content);
        const nOldSummary = applyRules(row.old_summary);
        const nNewTitle = applyRules(row.new_title);
        const nNewContent = applyRules(row.new_content);
        const nNewSummary = applyRules(row.new_summary);
        const nSrc = includeSourceUri ? applyRules(row.source_uri) : row.source_uri;

        if (
          nOldTitle !== row.old_title ||
          nOldContent !== row.old_content ||
          nOldSummary !== row.old_summary ||
          nNewTitle !== row.new_title ||
          nNewContent !== row.new_content ||
          nNewSummary !== row.new_summary ||
          nSrc !== row.source_uri
        ) {
          tables.memory_mutations.matchedRows++;
          const rid = String(row.mutation_id);
          if (nNewTitle !== row.new_title && row.new_title && nNewTitle) {
            recordSample("memory_mutations", rid, "new_title", row.new_title, nNewTitle);
          } else if (nNewContent !== row.new_content && row.new_content && nNewContent) {
            recordSample("memory_mutations", rid, "new_content", row.new_content, nNewContent);
          } else if (nOldContent !== row.old_content && row.old_content && nOldContent) {
            recordSample("memory_mutations", rid, "old_content", row.old_content, nOldContent);
          } else if (nOldTitle !== row.old_title && row.old_title && nOldTitle) {
            recordSample("memory_mutations", rid, "old_title", row.old_title, nOldTitle);
          }
          if (!dryRun) {
            this.sql.exec(
              `UPDATE memory_mutations
               SET old_title = ?1, old_content = ?2, old_summary = ?3,
                   new_title = ?4, new_content = ?5, new_summary = ?6, source_uri = ?7
               WHERE mutation_id = ?8`,
              nOldTitle,
              nOldContent,
              nOldSummary,
              nNewTitle,
              nNewContent,
              nNewSummary,
              nSrc,
              row.mutation_id
            );
            tables.memory_mutations.updatedRows++;
          }
        }
      }

      // 7. consolidation_runs
      const consRows = this.sql
        .exec<{ run_id: number; digest_title: string | null; digest_content: string | null }>(
          `SELECT run_id, digest_title, digest_content FROM consolidation_runs`
        )
        .toArray();
      tables.consolidation_runs.scanned = consRows.length;
      for (const row of consRows) {
        const nTitle = applyRules(row.digest_title);
        const nContent = applyRules(row.digest_content);
        if (nTitle !== row.digest_title || nContent !== row.digest_content) {
          tables.consolidation_runs.matchedRows++;
          const rid = String(row.run_id);
          if (nTitle !== row.digest_title && row.digest_title && nTitle) {
            recordSample("consolidation_runs", rid, "digest_title", row.digest_title, nTitle);
          }
          if (nContent !== row.digest_content && row.digest_content && nContent) {
            recordSample("consolidation_runs", rid, "digest_content", row.digest_content, nContent);
          }
          if (!dryRun) {
            this.sql.exec(
              `UPDATE consolidation_runs SET digest_title = ?1, digest_content = ?2 WHERE run_id = ?3`,
              nTitle,
              nContent,
              row.run_id
            );
            tables.consolidation_runs.updatedRows++;
          }
        }
      }

      // 8. memory_conflicts
      const confRows = this.sql
        .exec<{
          conflict_id: number;
          existing_title: string | null;
          existing_snippet: string | null;
          existing_edge_id: string | null;
          new_title: string | null;
          new_snippet: string | null;
          new_edge_id: string | null;
          reason: string;
          merged_content_proposal: string | null;
        }>(
          `SELECT conflict_id, existing_title, existing_snippet, existing_edge_id, new_title, new_snippet, new_edge_id, reason, merged_content_proposal FROM memory_conflicts`
        )
        .toArray();
      tables.memory_conflicts.scanned = confRows.length;
      for (const row of confRows) {
        const nExTitle = applyRules(row.existing_title);
        const nExSnip = applyRules(row.existing_snippet);
        const nExEdge = applyRules(row.existing_edge_id);
        const nNewTitle = applyRules(row.new_title);
        const nNewSnip = applyRules(row.new_snippet);
        const nNewEdge = applyRules(row.new_edge_id);
        const nReason = applyRules(row.reason) ?? row.reason;
        const nMerged = applyRules(row.merged_content_proposal);
        if (
          nExTitle !== row.existing_title ||
          nExSnip !== row.existing_snippet ||
          nExEdge !== row.existing_edge_id ||
          nNewTitle !== row.new_title ||
          nNewSnip !== row.new_snippet ||
          nNewEdge !== row.new_edge_id ||
          nReason !== row.reason ||
          nMerged !== row.merged_content_proposal
        ) {
          tables.memory_conflicts.matchedRows++;
          recordSample("memory_conflicts", String(row.conflict_id), "reason", row.reason, nReason);
          if (!dryRun) {
            this.sql.exec(
              `UPDATE memory_conflicts
               SET existing_title = ?1, existing_snippet = ?2, existing_edge_id = ?3,
                   new_title = ?4, new_snippet = ?5, new_edge_id = ?6,
                   reason = ?7, merged_content_proposal = ?8
               WHERE conflict_id = ?9`,
              nExTitle,
              nExSnip,
              nExEdge,
              nNewTitle,
              nNewSnip,
              nNewEdge,
              nReason,
              nMerged,
              row.conflict_id
            );
            tables.memory_conflicts.updatedRows++;
          }
        }
      }

      // 9. outcomes
      const outRows = this.sql
        .exec<{
          outcome_id: string;
          query: string;
          result_summary: string;
          failed_attempts: string | null;
          evidence_uri: string | null;
        }>(
          `SELECT outcome_id, query, result_summary, failed_attempts, evidence_uri FROM outcomes`
        )
        .toArray();
      tables.outcomes.scanned = outRows.length;
      for (const row of outRows) {
        const nQuery = applyRules(row.query) ?? row.query;
        const nSummary = applyRules(row.result_summary) ?? row.result_summary;
        const nFailed = applyRules(row.failed_attempts);
        const nEv = includeSourceUri ? applyRules(row.evidence_uri) : row.evidence_uri;
        if (
          nQuery !== row.query ||
          nSummary !== row.result_summary ||
          nFailed !== row.failed_attempts ||
          nEv !== row.evidence_uri
        ) {
          tables.outcomes.matchedRows++;
          recordSample("outcomes", row.outcome_id, "result_summary", row.result_summary, nSummary);
          if (!dryRun) {
            this.sql.exec(
              `UPDATE outcomes SET query = ?1, result_summary = ?2, failed_attempts = ?3, evidence_uri = ?4 WHERE outcome_id = ?5`,
              nQuery,
              nSummary,
              nFailed,
              nEv,
              row.outcome_id
            );
            tables.outcomes.updatedRows++;
          }
        }
      }

      // 10. memory_validations
      const valRows = this.sql
        .exec<{ validation_id: number; notes: string | null; evidence_uri: string | null }>(
          `SELECT validation_id, notes, evidence_uri FROM memory_validations`
        )
        .toArray();
      tables.memory_validations.scanned = valRows.length;
      for (const row of valRows) {
        const nNotes = applyRules(row.notes);
        const nEv = includeSourceUri ? applyRules(row.evidence_uri) : row.evidence_uri;
        if (nNotes !== row.notes || nEv !== row.evidence_uri) {
          tables.memory_validations.matchedRows++;
          if (nNotes !== row.notes && row.notes && nNotes) {
            recordSample("memory_validations", String(row.validation_id), "notes", row.notes, nNotes);
          }
          if (!dryRun) {
            this.sql.exec(
              `UPDATE memory_validations SET notes = ?1, evidence_uri = ?2 WHERE validation_id = ?3`,
              nNotes,
              nEv,
              row.validation_id
            );
            tables.memory_validations.updatedRows++;
          }
        }
      }
    };

    let ftsRebuilt = false;
    if (dryRun) {
      executePass();
    } else {
      this.ctx.storage.transactionSync(() => {
        executePass();
        if (tables.memories.updatedRows > 0) {
          this.sql.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
          ftsRebuilt = true;
        }
      });
    }

    // Re-embed modified active memories into Vectorize (gemini-brain-bge-m3) in safe batches
    let reindexedVectors = 0;
    if (!dryRun && reindexVectors && modifiedActiveMemoryIds.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < modifiedActiveMemoryIds.length; i += BATCH_SIZE) {
        const slice = modifiedActiveMemoryIds.slice(i, i + BATCH_SIZE);
        const reidx = await this.reindexMemories({
          memoryIds: slice,
          rebuildFts: false
        });
        reindexedVectors += reidx.reindexedVectors;
      }
    }

    return {
      ok: true,
      dryRun,
      tables,
      modifiedMemoryIds: modifiedAllMemoryIds,
      reindexedVectors,
      ftsRebuilt,
      samples
    };
  }

  /**
   * RPC Method 11C: Targeted Administrative Purge of Specific Decisions, Knowledge Graph Entities,
   * and Episodic Log Rows by exact ID (respects protected RPi5/Qdrant infrastructure guardrails).
   */
  async purgeRecords(params: {
    decisionIds?: string[];
    entityIds?: string[];
    episodicLogIds?: number[];
  }): Promise<{
    ok: boolean;
    deletedDecisions: number;
    deletedEntities: number;
    deletedEdges: number;
    deletedEpisodicLogs: number;
    skippedProtectedEntities: string[];
  }> {
    const decisionIds = Array.from(
      new Set((params.decisionIds ?? []).map((id) => String(id).trim()).filter(Boolean))
    );
    const entityIds = Array.from(
      new Set((params.entityIds ?? []).map((id) => String(id).trim()).filter(Boolean))
    );
    const episodicLogIds = Array.from(
      new Set(
        (params.episodicLogIds ?? [])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0)
      )
    );

    if (decisionIds.length === 0 && entityIds.length === 0 && episodicLogIds.length === 0) {
      throw new Error("purgeRecords requires at least one decisionId, entityId, or episodicLogId.");
    }

    let deletedDecisions = 0;
    let deletedEntities = 0;
    let deletedEdges = 0;
    let deletedEpisodicLogs = 0;
    const skippedProtectedEntities: string[] = [];

    this.ctx.storage.transactionSync(() => {
      for (const did of decisionIds) {
        const exists = this.sql
          .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM decisions WHERE decision_id = ?1`, did)
          .one().cnt;
        if (exists > 0) {
          this.sql.exec(`UPDATE decisions SET superseded_by = NULL WHERE superseded_by = ?1`, did);
          this.sql.exec(`DELETE FROM decisions WHERE decision_id = ?1`, did);
          deletedDecisions += exists;
        }
      }

      for (const eid of entityIds) {
        if (isProtectedInfrastructure(eid)) {
          skippedProtectedEntities.push(eid);
          continue;
        }
        const exists = this.sql
          .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM entities WHERE entity_id = ?1`, eid)
          .one().cnt;
        if (exists > 0) {
          const edgeCnt = this.sql
            .exec<{ cnt: number }>(
              `SELECT COUNT(*) AS cnt FROM edges WHERE source_entity = ?1 OR target_entity = ?1`,
              eid
            )
            .one().cnt;
          this.sql.exec(`DELETE FROM edges WHERE source_entity = ?1 OR target_entity = ?1`, eid);
          this.sql.exec(`DELETE FROM entities WHERE entity_id = ?1`, eid);
          deletedEntities += exists;
          deletedEdges += edgeCnt;
        }
      }

      for (const lid of episodicLogIds) {
        const exists = this.sql
          .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM episodic_logs WHERE log_id = ?1`, lid)
          .one().cnt;
        if (exists > 0) {
          this.sql.exec(`DELETE FROM episodic_logs WHERE log_id = ?1`, lid);
          deletedEpisodicLogs += exists;
        }
      }
    });

    return {
      ok: true,
      deletedDecisions,
      deletedEntities,
      deletedEdges,
      deletedEpisodicLogs,
      skippedProtectedEntities
    };
  }

  /**
   * RPC Method 11D: Silent Deterministic Namespace Backfill & Vectorize Namespace Migration.
   * Reclassifies misrouted daemon memories (e.g., Qdrant/Markdown chunks stuck in 'homelab')
   * into their canonical namespaces without flooding memory_mutations, updates non-protected
   * linked KG edges, rebuilds FTS5, and migrates Vectorize namespace partitions via getByIds
   * (zero AI Neurons) with embedTexts fallback for any unindexed IDs.
   */
  async reclassifyNamespaces(params: ReclassifyNamespacesParams = {}): Promise<{
    ok: boolean;
    dryRun: boolean;
    sourceNamespace: string;
    scanned: number;
    matchedCount: number;
    updatedMemories: number;
    updatedEdges: number;
    ftsRebuilt: boolean;
    vectorsCopiedById: number;
    vectorsReembedded: number;
    byTargetNamespace: Record<string, number>;
    movedMemoryIds: string[];
    samples: Array<{ id: string; from: string; to: string; title: string; sourceUri: string | null }>;
  }> {
    const sourceNamespace = (params.sourceNamespace || "homelab").trim();
    const dryRun = params.dryRun !== false;
    const reindexVectors = params.reindexVectors !== false;
    const updateEdges = params.updateEdges !== false;
    const includePrefixes =
      Array.isArray(params.includePrefixes) && params.includePrefixes.length > 0
        ? params.includePrefixes.map((p) => String(p).trim()).filter(Boolean)
        : ["qdrant_", "md_", "py_"];
    const maxSamples = Math.max(5, Math.min(200, params.maxSamples ?? 40));

    // Vector-only batch mode: migrate Vectorize namespace partition for specific already-reclassified IDs
    if (Array.isArray(params.vectorOnlyIds) && params.vectorOnlyIds.length > 0) {
      const targetIds = Array.from(
        new Set(params.vectorOnlyIds.map((id) => String(id).trim()).filter(Boolean))
      ).slice(0, 250);
      const rows = this.sql
        .exec<{ id: string; namespace: string; memory_type: string; title: string; content: string }>(
          `SELECT id, namespace, memory_type, title, content
           FROM memories
           WHERE id IN (SELECT value FROM json_each(?1))
             AND superseded_by IS NULL`,
          JSON.stringify(targetIds)
        )
        .toArray();
      const { copiedById, reembedded } = await this.migrateVectorNamespaces(rows);
      return {
        ok: true,
        dryRun: false,
        sourceNamespace,
        scanned: rows.length,
        matchedCount: rows.length,
        updatedMemories: 0,
        updatedEdges: 0,
        ftsRebuilt: false,
        vectorsCopiedById: copiedById,
        vectorsReembedded: reembedded,
        byTargetNamespace: {},
        movedMemoryIds: rows.map((r) => r.id),
        samples: []
      };
    }

    const candidates = this.sql
      .exec<{
        id: string;
        namespace: string;
        memory_type: string;
        title: string;
        content: string;
        source_uri: string | null;
      }>(
        `SELECT id, namespace, memory_type, title, content, source_uri
         FROM memories
         WHERE namespace = ?1
           AND superseded_by IS NULL`,
        sourceNamespace
      )
      .toArray();

    const byTargetNamespace: Record<string, number> = {};
    const movedRows: Array<{
      id: string;
      from: string;
      to: string;
      memory_type: string;
      title: string;
      content: string;
      source_uri: string | null;
    }> = [];
    const samples: Array<{ id: string; from: string; to: string; title: string; sourceUri: string | null }> = [];

    for (const row of candidates) {
      if (!includePrefixes.some((pfx) => row.id.startsWith(pfx))) continue;
      if (isProtectedInfrastructure(row.id) || isProtectedInfrastructure(row.title)) continue;

      const targetNs = classifyMemoryNamespace(row.title, row.source_uri, row.namespace);
      if (targetNs !== row.namespace) {
        byTargetNamespace[targetNs] = (byTargetNamespace[targetNs] || 0) + 1;
        movedRows.push({
          id: row.id,
          from: row.namespace,
          to: targetNs,
          memory_type: row.memory_type,
          title: row.title,
          content: row.content,
          source_uri: row.source_uri
        });
        if (samples.length < maxSamples) {
          samples.push({
            id: row.id,
            from: row.namespace,
            to: targetNs,
            title: row.title.slice(0, 140),
            sourceUri: row.source_uri
          });
        }
      }
    }

    let updatedMemories = 0;
    let updatedEdges = 0;
    let ftsRebuilt = false;

    if (!dryRun && movedRows.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const m of movedRows) {
          this.sql.exec(`UPDATE memories SET namespace = ?1 WHERE id = ?2`, m.to, m.id);
          updatedMemories++;

          if (updateEdges) {
            const linked = this.sql
              .exec<{ edge_id: string }>(
                `SELECT edge_id FROM edges WHERE evidence_memory_id = ?1 AND valid_until IS NULL`,
                m.id
              )
              .toArray();
            for (const e of linked) {
              if (isProtectedInfrastructure(e.edge_id)) continue;
              this.sql.exec(`UPDATE edges SET namespace = ?1 WHERE edge_id = ?2`, m.to, e.edge_id);
              updatedEdges++;
            }
          }
        }
        this.sql.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
        ftsRebuilt = true;
      });
    }

    let vectorsCopiedById = 0;
    let vectorsReembedded = 0;
    if (!dryRun && reindexVectors && movedRows.length > 0) {
      const migrated = await this.migrateVectorNamespaces(
        movedRows.map((m) => ({
          id: m.id,
          namespace: m.to,
          memory_type: m.memory_type,
          title: m.title,
          content: m.content
        }))
      );
      vectorsCopiedById = migrated.copiedById;
      vectorsReembedded = migrated.reembedded;
    }

    return {
      ok: true,
      dryRun,
      sourceNamespace,
      scanned: candidates.length,
      matchedCount: movedRows.length,
      updatedMemories,
      updatedEdges,
      ftsRebuilt,
      vectorsCopiedById,
      vectorsReembedded,
      byTargetNamespace,
      movedMemoryIds: movedRows.map((m) => m.id),
      samples
    };
  }

  private async migrateVectorNamespaces(
    rows: Array<{ id: string; namespace: string; memory_type: string; title: string; content: string }>
  ): Promise<{ copiedById: number; reembedded: number }> {
    if (rows.length === 0 || !this.env.VECTOR_INDEX) {
      return { copiedById: 0, reembedded: 0 };
    }

    const existingValuesById = new Map<string, number[]>();
    const vecIndex = this.env.VECTOR_INDEX as VectorizeIndex & {
      getByIds?: (ids: string[]) => Promise<Array<{ id: string; values?: number[] | Float32Array }>>;
    };

    if (typeof vecIndex.getByIds === "function") {
      // Cloudflare Vectorize v2 getByIds supports up to 20 IDs per request
      for (let i = 0; i < rows.length; i += 20) {
        const sliceIds = rows.slice(i, i + 20).map((r) => r.id);
        try {
          const found = await vecIndex.getByIds(sliceIds);
          for (const rec of found || []) {
            if (rec?.id && rec.values && rec.values.length > 0) {
              existingValuesById.set(rec.id, Array.from(rec.values));
            }
          }
        } catch {
          // Fall back to embedTexts for any batch that cannot be read via getByIds
        }
      }
    }

    const vectorsToUpsert: VectorizeVector[] = [];
    const missingRows: typeof rows = [];
    let copiedById = 0;

    for (const r of rows) {
      const vals = existingValuesById.get(r.id);
      if (vals && vals.length > 0) {
        vectorsToUpsert.push({
          id: r.id,
          values: vals,
          namespace: r.namespace,
          metadata: {
            namespace: r.namespace,
            title: r.title.slice(0, 500),
            memory_type: r.memory_type
          }
        });
        copiedById++;
      } else {
        missingRows.push(r);
      }
    }

    let reembedded = 0;
    if (missingRows.length > 0) {
      const embedded = await this.embedTexts(
        missingRows.map((r) => `${r.title.slice(0, 300)}\n${r.content.slice(0, 3500)}`)
      );
      missingRows.forEach((r, idx) => {
        const vals = embedded[idx];
        if (vals && vals.length > 0) {
          vectorsToUpsert.push({
            id: r.id,
            values: vals,
            namespace: r.namespace,
            metadata: {
              namespace: r.namespace,
              title: r.title.slice(0, 500),
              memory_type: r.memory_type
            }
          });
          reembedded++;
        }
      });
    }

    for (let i = 0; i < vectorsToUpsert.length; i += 100) {
      await this.env.VECTOR_INDEX.upsert(vectorsToUpsert.slice(i, i + 100));
    }

    return { copiedById, reembedded };
  }

  /**
   * RPC Method 12: Cognitive NOC Dashboard Snapshot
   * Aggregates Knowledge Graph nodes/edges, Memory Types status & content by namespace,
   * Surfaces activity matrix, Databases health, and Nocturnal Sleep Cycle audit stream.
   */
  async getDashboardSnapshot(params: {
    namespace?: string;
    memoryType?: string;
    search?: string;
    limit?: number;
  } = {}) {
    const nsFilter = (params.namespace || "all").trim();
    const matchAllNs = nsFilter === "all" || nsFilter === "" ? 1 : 0;
    const typeFilter = (params.memoryType || "all").trim();
    const matchAllTypes = typeFilter === "all" || typeFilter === "" ? 1 : 0;
    const searchFilter = (params.search || "").trim().toLowerCase();
    const limit = Math.max(10, Math.min(300, params.limit ?? 150));

    // 1. Global & Namespace Telemetry Counts
    const stats = await this.getNamespaceStats("all");

    const totalTokensRow = this.sql
      .exec<{ total_tokens: number; superseded_count: number; total_accesses: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN superseded_by IS NULL THEN token_count ELSE 0 END), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END), 0) AS superseded_count,
           COALESCE(SUM(CASE WHEN superseded_by IS NULL THEN access_count ELSE 0 END), 0) AS total_accesses
         FROM memories`
      )
      .one();

    // 2. Memory Types Status by Namespace Matrix (semantic, procedural, episodic_summary)
    const memoryTypeMatrixRows = this.sql
      .exec<{
        namespace: string;
        memory_type: string;
        count: number;
        total_tokens: number;
        avg_importance: number;
        avg_confidence: number;
        total_accesses: number;
        latest_updated_at: number;
      }>(
        `SELECT
           namespace,
           memory_type,
           COUNT(*) AS count,
           COALESCE(SUM(token_count), 0) AS total_tokens,
           ROUND(AVG(importance), 3) AS avg_importance,
           ROUND(AVG(confidence), 3) AS avg_confidence,
           COALESCE(SUM(access_count), 0) AS total_accesses,
           MAX(updated_at) AS latest_updated_at
         FROM memories
         WHERE superseded_by IS NULL
         GROUP BY namespace, memory_type
         ORDER BY namespace ASC, count DESC`
      )
      .toArray();

    const memoryTypeTotalsRows = this.sql
      .exec<{
        memory_type: string;
        count: number;
        total_tokens: number;
        avg_importance: number;
        total_accesses: number;
        latest_updated_at: number;
      }>(
        `SELECT
           memory_type,
           COUNT(*) AS count,
           COALESCE(SUM(token_count), 0) AS total_tokens,
           ROUND(AVG(importance), 3) AS avg_importance,
           COALESCE(SUM(access_count), 0) AS total_accesses,
           MAX(updated_at) AS latest_updated_at
         FROM memories
         WHERE superseded_by IS NULL
         GROUP BY memory_type
         ORDER BY count DESC`
      )
      .toArray();

    // 3. Memory Content Explorer (Filterable by namespace, memory_type, and search text)
    const memoriesList = this.sql
      .exec<{
        id: string;
        namespace: string;
        memory_type: string;
        title: string;
        content: string;
        summary: string | null;
        source_uri: string | null;
        token_count: number;
        importance: number;
        confidence: number;
        access_count: number;
        created_at: number;
        updated_at: number;
        last_accessed_at: number;
      }>(
        `SELECT
           id, namespace, memory_type, title, content, summary, source_uri,
           token_count, importance, confidence, access_count,
           created_at, updated_at, last_accessed_at
         FROM memories
         WHERE superseded_by IS NULL
           AND (?1 = 1 OR namespace = ?2)
           AND (?3 = 1 OR memory_type = ?4)
           AND (?5 = '' OR LOWER(title) LIKE '%' || ?5 || '%' OR LOWER(content) LIKE '%' || ?5 || '%' OR LOWER(id) LIKE '%' || ?5 || '%')
         ORDER BY updated_at DESC
         LIMIT ?6`,
        matchAllNs,
        nsFilter,
        matchAllTypes,
        typeFilter,
        searchFilter,
        limit
      )
      .toArray();

    // 4. Interactive Knowledge Graph Entities & Active Edges
    const graphNodes = this.sql
      .exec<{
        entity_id: string;
        namespace: string;
        entity_type: string;
        canonical_name: string;
        description: string | null;
        pagerank_score: number;
        updated_at: number;
      }>(
        `SELECT
           entity_id, namespace, entity_type, canonical_name, description, pagerank_score, updated_at
         FROM entities
         ORDER BY pagerank_score DESC, updated_at DESC
         LIMIT 250`
      )
      .toArray();

    const graphEdges = this.sql
      .exec<{
        edge_id: string;
        namespace: string;
        source_entity: string;
        relation: string;
        target_entity: string;
        weight: number;
        evidence_memory_id: string | null;
        valid_from: number;
      }>(
        `SELECT
           edge_id, namespace, source_entity, relation, target_entity, weight, evidence_memory_id, valid_from
         FROM edges
         WHERE valid_until IS NULL
         ORDER BY valid_from DESC
         LIMIT 400`
      )
      .toArray();

    // 5. Surfaces Activity Matrix (Aggregated across memory_mutations & episodic_logs)
    const mutationClients = this.sql
      .exec<{
        client_id: string;
        mutations_count: number;
        last_mutation_at: number;
      }>(
        `SELECT
           client_id,
           COUNT(*) AS mutations_count,
           MAX(created_at) AS last_mutation_at
         FROM memory_mutations
         GROUP BY client_id`
      )
      .toArray();

    const episodicClients = this.sql
      .exec<{
        client_id: string;
        episodic_count: number;
        pending_count: number;
        last_episodic_at: number;
      }>(
        `SELECT
           client_id,
           COUNT(*) AS episodic_count,
           SUM(CASE WHEN consolidated = 0 THEN 1 ELSE 0 END) AS pending_count,
           MAX(created_at) AS last_episodic_at
         FROM episodic_logs
         GROUP BY client_id`
      )
      .toArray();

    // Check preserved RPi5 & Qdrant Knowledge Graph footprint
    const rpi5GraphStats = this.sql
      .exec<{ entities_count: number; edges_count: number }>(
        `SELECT
           (SELECT COUNT(*) FROM entities WHERE LOWER(entity_id) LIKE '%rpi5%' OR LOWER(entity_id) LIKE '%qdrant%') AS entities_count,
           (SELECT COUNT(*) FROM edges WHERE valid_until IS NULL AND (LOWER(source_entity) LIKE '%rpi5%' OR LOWER(target_entity) LIKE '%rpi5%' OR LOWER(source_entity) LIKE '%qdrant%' OR LOWER(target_entity) LIKE '%qdrant%')) AS edges_count`
      )
      .one();

    // 6. D1 Archive Knowledge DB Live Record Count + Federated Database Activity Timestamps
    const normalizeTimestampSec = (raw: unknown): number => {
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
      }
      if (typeof raw === "string" && raw.trim()) {
        const asNum = Number(raw.trim());
        if (Number.isFinite(asNum) && asNum > 0) {
          return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
        }
        const parsedMs = parseIsoToMs(raw);
        if (parsedMs && parsedMs > 0) {
          return Math.floor(parsedMs / 1000);
        }
      }
      return 0;
    };

    const doSqliteActivityRow = this.sql
      .exec<{ last_ts: number }>(
        `SELECT MAX(
           COALESCE((SELECT MAX(updated_at) FROM memories), 0),
           COALESCE((SELECT MAX(last_accessed_at) FROM memories), 0),
           COALESCE((SELECT MAX(updated_at) FROM entities), 0),
           COALESCE((SELECT MAX(valid_from) FROM edges), 0),
           COALESCE((SELECT MAX(created_at) FROM decisions), 0),
           COALESCE((SELECT MAX(created_at) FROM episodic_logs), 0),
           COALESCE((SELECT MAX(created_at) FROM memory_mutations), 0),
           COALESCE((SELECT MAX(created_at) FROM consolidation_runs), 0),
           COALESCE((SELECT MAX(created_at) FROM outcomes), 0),
           COALESCE((SELECT MAX(created_at) FROM memory_validations), 0)
         ) AS last_ts`
      )
      .one();

    const brainVecSqlActivityRow = this.sql
      .exec<{ last_ts: number }>(
        `SELECT MAX(
           COALESCE((SELECT MAX(updated_at) FROM memories WHERE superseded_by IS NULL), 0),
           COALESCE((SELECT MAX(last_accessed_at) FROM memories WHERE superseded_by IS NULL), 0),
           COALESCE((SELECT MAX(created_at) FROM memory_mutations), 0)
         ) AS last_ts`
      )
      .one();

    const rpi5ActivityRow = this.sql
      .exec<{ last_ts: number }>(
        `SELECT MAX(
           COALESCE((SELECT MAX(created_at) FROM memory_mutations
             WHERE (LOWER(client_id) LIKE '%rpi5%' OR LOWER(client_id) LIKE '%qdrant%' OR LOWER(source_uri) LIKE 'rpi5://%' OR LOWER(source_uri) LIKE 'qdrant://%')
               AND LOWER(client_id) NOT LIKE '%cli%'), 0),
           COALESCE((SELECT MAX(created_at) FROM episodic_logs
             WHERE (LOWER(client_id) LIKE '%rpi5%' OR LOWER(client_id) LIKE '%qdrant%')
               AND LOWER(client_id) NOT LIKE '%cli%'), 0),
           COALESCE((SELECT MAX(updated_at) FROM memories
             WHERE LOWER(source_uri) LIKE 'rpi5://%' OR LOWER(source_uri) LIKE 'qdrant://%'), 0),
           COALESCE((SELECT MAX(updated_at) FROM entities
             WHERE LOWER(entity_id) LIKE '%rpi5%' OR LOWER(entity_id) LIKE '%qdrant%'), 0),
           COALESCE((SELECT MAX(valid_from) FROM edges
             WHERE valid_until IS NULL
               AND (LOWER(source_entity) LIKE '%rpi5%' OR LOWER(target_entity) LIKE '%rpi5%' OR LOWER(source_entity) LIKE '%qdrant%' OR LOWER(target_entity) LIKE '%qdrant%')), 0)
         ) AS last_ts`
      )
      .one();

    let d1ArchiveCount = 14422;
    let d1Status = "ONLINE_FEDERATED";
    let d1LastActivityAt = 0;
    let brainVecDescribeTs = 0;
    let kbVecDescribeTs = 0;

    const [d1CountRes, d1ActivityRes, brainVecDescRes, kbVecDescRes] = await Promise.allSettled([
      this.env.KB_DB
        ? this.env.KB_DB.prepare(`SELECT COUNT(*) AS count FROM kb_fts`).first<{ count: number }>()
        : Promise.resolve(null),
      this.env.KB_DB
        ? this.env.KB_DB.prepare(
            `SELECT MAX(last_updated) AS latest_updated, MAX(modified_iso) AS latest_modified FROM files`
          ).first<{ latest_updated: string | null; latest_modified: string | null }>()
        : Promise.resolve(null),
      typeof this.env.VECTOR_INDEX?.describe === "function"
        ? this.env.VECTOR_INDEX.describe()
        : Promise.resolve(null),
      typeof this.env.KB_VECTORIZE?.describe === "function"
        ? this.env.KB_VECTORIZE.describe()
        : Promise.resolve(null)
    ]);

    if (this.env.KB_DB) {
      if (
        d1CountRes.status === "fulfilled" &&
        d1CountRes.value &&
        typeof d1CountRes.value.count === "number" &&
        d1CountRes.value.count > 0
      ) {
        d1ArchiveCount = d1CountRes.value.count;
      } else if (d1CountRes.status === "rejected") {
        d1Status = "FALLBACK_CACHED";
      }
      if (d1ActivityRes.status === "fulfilled" && d1ActivityRes.value) {
        d1LastActivityAt = Math.max(
          normalizeTimestampSec(d1ActivityRes.value.latest_updated),
          normalizeTimestampSec(d1ActivityRes.value.latest_modified)
        );
      }
    }

    if (brainVecDescRes.status === "fulfilled" && brainVecDescRes.value) {
      brainVecDescribeTs = normalizeTimestampSec(
        (brainVecDescRes.value as { processedUpToDatetime?: unknown }).processedUpToDatetime
      );
    }
    if (kbVecDescRes.status === "fulfilled" && kbVecDescRes.value) {
      kbVecDescribeTs = normalizeTimestampSec(
        (kbVecDescRes.value as { processedUpToDatetime?: unknown }).processedUpToDatetime
      );
    }

    const doSqliteLastActivityAt = normalizeTimestampSec(doSqliteActivityRow?.last_ts);
    const brainVecLastActivityAt = Math.max(
      brainVecDescribeTs,
      normalizeTimestampSec(brainVecSqlActivityRow?.last_ts)
    );
    const kbVecLastActivityAt = kbVecDescribeTs > 0 ? kbVecDescribeTs : d1LastActivityAt;
    const rpi5LastActivityAt = normalizeTimestampSec(rpi5ActivityRow?.last_ts);

    // 7. Active Decisions, Pending Episodic Logs, Consolidation Runs & Recent Mutations
    const activeDecisionsList = this.sql
      .exec<{
        decision_id: string;
        namespace: string;
        title: string;
        decision: string;
        rationale: string;
        status: string;
        created_at: number;
      }>(
        `SELECT decision_id, namespace, title, decision, rationale, status, created_at
         FROM decisions
         WHERE status = 'active'
         ORDER BY created_at DESC
         LIMIT 50`
      )
      .toArray();

    const pendingEpisodicList = this.sql
      .exec<EpisodicLogRow & { consolidated: number }>(
        `SELECT log_id, session_id, client_id, event_type, payload, consolidated, created_at
         FROM episodic_logs
         ORDER BY created_at DESC
         LIMIT 40`
      )
      .toArray();

    const consolidationRunsList = this.sql
      .exec<ConsolidationRunRow>(
        `SELECT run_id, digest_memory_id, events_count, clients_json, log_ids_json,
                digest_title, digest_content, trigger_source, created_at
         FROM consolidation_runs
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .toArray();

    const recentMutationsList = this.sql
      .exec<MutationAuditRow>(
        `SELECT
           mutation_id, memory_id, namespace, memory_type, operation, client_id,
           old_title, old_content, old_summary, old_importance,
           new_title, new_content, new_summary, new_importance,
           source_uri, rolled_back, created_at
         FROM memory_mutations
         ORDER BY created_at DESC, mutation_id DESC
         LIMIT 40`
      )
      .toArray();

    const memoryConflictsList = this.sql
      .exec<MemoryConflictRow>(
        `SELECT
           conflict_id, run_id, namespace, conflict_type, severity,
           existing_memory_id, existing_title, existing_snippet, existing_edge_id, existing_decision_id,
           new_memory_id, new_title, new_snippet, new_edge_id,
           reason, suggested_action, merged_content_proposal,
           status, resolution_action, resolved_by, created_at, resolved_at
         FROM memory_conflicts
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC, created_at DESC
         LIMIT 40`
      )
      .toArray();

    const recentOutcomesList = this.sql
      .exec<OutcomeRow>(
        `SELECT
           outcome_id, session_id, namespace, task_type, query, status,
           result_summary, failed_attempts, cited_memory_ids_json,
           verifier, evidence_uri, operator_feedback, client_id, created_at
         FROM outcomes
         ORDER BY created_at DESC
         LIMIT 30`
      )
      .toArray();

    const validationsCount = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM memory_validations`)
      .one().count;

    return {
      serverTimeIso: new Date().toISOString(),
      telemetry: {
        ...stats,
        totalTokensStored: totalTokensRow.total_tokens,
        supersededMemories: totalTokensRow.superseded_count,
        totalRecalls: totalTokensRow.total_accesses,
        outcomesCount: recentOutcomesList.length,
        validationsCount,
        d1ArchiveCount,
        d1Status
      },
      memoryTypesStatus: {
        totalsByType: memoryTypeTotalsRows,
        byNamespaceAndType: memoryTypeMatrixRows
      },
      memories: memoriesList,
      graph: {
        nodes: graphNodes,
        edges: graphEdges
      },
      surfaces: {
        mutationClients,
        episodicClients,
        rpi5Preserved: {
          rpiSyncEnabled: true,
          hardwareStatus: "ONLINE_ACTIVE",
          preservedEntities: rpi5GraphStats.entities_count,
          preservedActiveEdges: rpi5GraphStats.edges_count
        }
      },
      databases: [
        {
          id: "brain-do-sqlite",
          name: "BrainMemoryDO SQLite",
          engine: "Cloudflare Durable Objects SQLite + FTS5 + KG",
          role: "Tier-1 Active Semantic, Procedural, Episodic & Property Graph Store",
          status: "ONLINE",
          records: stats.activeMemories + stats.activeEntities + stats.activeEdges + stats.activeDecisions,
          lastActivityAt: doSqliteLastActivityAt,
          details: `${stats.activeMemories} Memories • ${stats.activeEntities} Entities • ${stats.activeEdges} Edges • ${stats.activeDecisions} ADRs • ${stats.pendingConflicts} Pending Conflicts`
        },
        {
          id: "brain-vectorize-1024",
          name: "gemini-brain-bge-m3",
          engine: "Cloudflare Vectorize (1024-dim Cosine)",
          role: "Dense Multilingual Semantic Embeddings (@cf/baai/bge-m3)",
          status: "ONLINE",
          records: stats.activeMemories,
          lastActivityAt: brainVecLastActivityAt,
          details: `${stats.activeMemories} Active 1024-dim Vectors • Cross-Encoder Reranker (@cf/baai/bge-reranker-base)`
        },
        {
          id: "kb-d1-archive",
          name: "archive-knowledge-db",
          engine: "Cloudflare D1 SQLite (kb_fts BM25)",
          role: "Tier-2 Deep Historical Archive (kb.tsimon.me)",
          status: d1Status,
          records: d1ArchiveCount,
          lastActivityAt: d1LastActivityAt,
          details: `${d1ArchiveCount.toLocaleString()} Indexed Documents, Emails, Spreadsheets & CMDB Records`
        },
        {
          id: "kb-vectorize-768",
          name: "archive-kb-index",
          engine: "Cloudflare Vectorize (768-dim Cosine)",
          role: "Historical Archive Semantic Vectors (@cf/baai/bge-base-en-v1.5)",
          status: "ONLINE",
          records: d1ArchiveCount,
          lastActivityAt: kbVecLastActivityAt,
          details: `Hydrated on-the-fly against D1 kb_fts via canonical rel_path (ADR-04)`
        },
        {
          id: "rpi5-qdrant-edge",
          name: "service:rpi5-qdrant-knowledge-hub",
          engine: "Raspberry Pi 5 Qdrant + AST Watcher",
          role: "Tier-3 Local Edge Vault (node:rpi5)",
          status: "ONLINE_FEDERATED",
          records: rpi5GraphStats.entities_count + rpi5GraphStats.edges_count,
          lastActivityAt: rpi5LastActivityAt,
          details: `RPI_SYNC_ENABLED=true • ${rpi5GraphStats.entities_count} Graph Nodes & ${rpi5GraphStats.edges_count} Active Edges Linked (valid_until = NULL)`
        }
      ].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)),
      sleepCycle: {
        nextAlarmIso: stats.nextAlarmIso,
        pendingCount: stats.pendingEpisodicLogs,
        pendingConflictsCount: stats.pendingConflicts,
        pendingLogs: pendingEpisodicList,
        consolidationRuns: consolidationRunsList,
        activeDecisions: activeDecisionsList,
        recentMutations: recentMutationsList,
        conflicts: memoryConflictsList,
        outcomes: recentOutcomesList
      }
    };
  }

  /**
   * Disaster Recovery RPC 1: Capture 30-day Durable Object SQLite PITR Bookmark + Table Row Counts
   */
  async getPitrBookmark(params: { atTimestampMs?: number } = {}) {
    const storageAny = this.ctx.storage as unknown as {
      getCurrentBookmark?: () => Promise<string>;
      getBookmarkForTime?: (ts: number | Date) => Promise<string>;
    };

    let bookmark: string | null = null;
    let pitrSupported = false;
    if (typeof params.atTimestampMs === "number" && Number.isFinite(params.atTimestampMs)) {
      if (typeof storageAny.getBookmarkForTime === "function") {
        pitrSupported = true;
        bookmark = await storageAny.getBookmarkForTime(params.atTimestampMs);
      }
    } else if (typeof storageAny.getCurrentBookmark === "function") {
      pitrSupported = true;
      bookmark = await storageAny.getCurrentBookmark();
    }

    const coreTables = [
      "memories",
      "entities",
      "edges",
      "decisions",
      "episodic_logs",
      "memory_mutations",
      "consolidation_runs",
      "memory_conflicts",
      "outcomes",
      "memory_validations"
    ] as const;

    const tableCounts: Record<string, number> = {};
    for (const tbl of coreTables) {
      tableCounts[tbl] = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tbl}`).one().count;
    }

    return {
      ok: true,
      objectName: "thomas-simon-primary-brain",
      capturedAtIso: new Date().toISOString(),
      pitrSupported,
      bookmark,
      tableCounts
    };
  }

  /**
   * Disaster Recovery RPC 2: Schedule 30-day In-Place SQLite PITR Rollback
   */
  async restorePitrBookmark(params: {
    bookmark?: string;
    confirm?: string;
    abortNow?: boolean;
  }) {
    if (params.confirm !== "CONFIRM_PITR_RESTORE") {
      return {
        ok: false,
        error: "Confirmation required: pass confirm='CONFIRM_PITR_RESTORE'."
      };
    }
    const targetBookmark = String(params.bookmark || "").trim();
    if (!targetBookmark || targetBookmark.length > 256 || !/^[A-Za-z0-9._-]+$/.test(targetBookmark)) {
      return {
        ok: false,
        error: "Invalid or missing PITR bookmark."
      };
    }

    const storageAny = this.ctx.storage as unknown as {
      getCurrentBookmark?: () => Promise<string>;
      onNextSessionRestoreBookmark?: (bm: string) => Promise<string>;
    };

    if (typeof storageAny.onNextSessionRestoreBookmark !== "function") {
      return {
        ok: false,
        error: "Durable Object PITR restore API is unavailable in this runtime."
      };
    }

    const preRestoreBookmark =
      typeof storageAny.getCurrentBookmark === "function"
        ? await storageAny.getCurrentBookmark()
        : null;

    const scheduledBookmark = await storageAny.onNextSessionRestoreBookmark(targetBookmark);

    if (params.abortNow === true) {
      this.ctx.abort("Operator-confirmed PITR restore");
    }

    return {
      ok: true,
      preRestoreBookmark,
      targetBookmark,
      scheduledBookmark,
      mode: params.abortNow === true ? "aborted_for_immediate_restore" : "scheduled_on_next_session"
    };
  }

  /**
   * Disaster Recovery RPC 3: Idempotent Logical Batch Table Restore from Encrypted SQLite Backup
   * Used for >30-day recovery or full namespace/account rebuilds where raw main.sqlite upload is unavailable.
   */
  async restoreTableBatch(params: {
    table: string;
    rows: Record<string, unknown>[];
    rebuildFts?: boolean;
  }) {
    const ALLOWED_TABLES: Record<string, readonly string[]> = {
      memories: [
        "id", "namespace", "memory_type", "title", "content", "summary", "source_uri",
        "token_count", "importance", "confidence", "access_count", "superseded_by",
        "metadata_json", "created_at", "updated_at", "last_accessed_at"
      ],
      entities: [
        "entity_id", "namespace", "entity_type", "canonical_name", "description",
        "pagerank_score", "attributes_json", "updated_at"
      ],
      edges: [
        "edge_id", "namespace", "source_entity", "relation", "target_entity",
        "weight", "evidence_memory_id", "valid_from", "valid_until"
      ],
      decisions: [
        "decision_id", "namespace", "title", "decision", "rationale",
        "status", "superseded_by", "created_at"
      ],
      episodic_logs: [
        "log_id", "session_id", "client_id", "event_type", "payload", "consolidated", "created_at"
      ],
      memory_mutations: [
        "mutation_id", "memory_id", "namespace", "memory_type", "operation", "client_id",
        "old_title", "old_content", "old_summary", "old_importance",
        "new_title", "new_content", "new_summary", "new_importance",
        "source_uri", "rolled_back", "created_at"
      ],
      consolidation_runs: [
        "run_id", "digest_memory_id", "events_count", "clients_json", "log_ids_json",
        "digest_title", "digest_content", "trigger_source", "created_at"
      ],
      memory_conflicts: [
        "conflict_id", "run_id", "namespace", "conflict_type", "severity",
        "existing_memory_id", "existing_title", "existing_snippet", "existing_edge_id", "existing_decision_id",
        "new_memory_id", "new_title", "new_snippet", "new_edge_id",
        "reason", "suggested_action", "merged_content_proposal",
        "status", "resolution_action", "resolved_by", "created_at", "resolved_at"
      ],
      outcomes: [
        "outcome_id", "session_id", "namespace", "task_type", "query", "status",
        "result_summary", "failed_attempts", "cited_memory_ids_json", "verifier",
        "evidence_uri", "operator_feedback", "client_id", "created_at"
      ],
      memory_validations: [
        "validation_id", "memory_id", "verdict", "previous_confidence", "new_confidence",
        "evidence_uri", "notes", "client_id", "observed_at", "created_at"
      ]
    };

    const table = String(params.table || "").trim();
    const allowedCols = ALLOWED_TABLES[table];
    if (!allowedCols) {
      return { ok: false, error: `Unsupported restore table: ${table}` };
    }

    const rows = Array.isArray(params.rows) ? params.rows : [];
    if (rows.length > 500) {
      return { ok: false, error: "Batch too large: maximum 500 rows per restore-batch call." };
    }

    let restored = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("PRAGMA foreign_keys = OFF;");
      try {
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const cols = allowedCols.filter((c) => Object.prototype.hasOwnProperty.call(row, c));
          if (cols.length === 0) continue;
          const placeholders = cols.map(() => "?").join(", ");
          const values = cols.map((c) => {
            const v = row[c];
            return v === undefined ? null : v;
          });
          this.sql.exec(
            `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
            ...values
          );
          restored++;
        }
        if (params.rebuildFts === true) {
          this.sql.exec(`DELETE FROM memories_fts;`);
          this.sql.exec(
            `INSERT INTO memories_fts(rowid, id, namespace, title, content, summary)
             SELECT rowid, id, namespace, title, content, COALESCE(summary, '')
             FROM memories WHERE superseded_by IS NULL;`
          );
        }
      } finally {
        this.sql.exec("PRAGMA foreign_keys = ON;");
      }
    });

    return {
      ok: true,
      table,
      restoredCount: restored,
      ftsRebuilt: params.rebuildFts === true
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
