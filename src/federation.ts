/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\federation.ts
 * Purpose: 4-Way Weighted Reciprocal Rank Fusion (RRF) & Direct Edge Federation
 *          between BrainMemoryDO (SQLite + gemini-brain-bge-m3 1024-dim) and
 *          kb.tsimon.me (D1 archive-knowledge-db + archive-kb-index 768-dim).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./memory-do";

export interface RankedCandidate {
  id: string;
  source: "brain_fts" | "brain_vec" | "kb_fts" | "kb_vec";
  origin: "brain.tsimon.me" | "kb.tsimon.me";
  memoryType?: "semantic" | "procedural" | "episodic_summary";
  title: string;
  content: string;
  summary?: string | null;
  uri: string;
  namespace: string;
  rawScore: number;
  importance: number; // 0.0 to 1.0
  confidence?: number; // 0.0 to 1.0 epistemic certainty (default 1.0)
  updatedAtMs: number;
  modifiedIso?: string | null;
  triples?: Array<{ subject: string; predicate: string; object: string }>;
}

export interface ScoreExplanation {
  channels: {
    brain_fts?: number;
    brain_vec?: number;
    kb_fts?: number;
    kb_vec?: number;
  };
  rawRrf: number;
  modifiers: {
    importance: number;
    importanceBoost: number;
    confidence: number;
    confidenceBoost: number;
    ageDays: number;
    halfLifeDays: number;
    decayFactor: number;
    rerankRawScore?: number;
    rerankBoost?: number;
  };
  finalScore: number;
  packedMode?: "full" | "condensed";
}

export interface FusedContextResult {
  contextBlock: string;
  totalTokens: number;
  tokenBudget: number;
  selectedCount: number;
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
}

export interface KbFtsRow {
  source_type: string;
  ref_id: string;
  rel_path: string;
  title: string;
  primary_theme: string;
  client_code: string;
  organization_name: string;
  content: string;
  modified_iso: string | null;
  fts_score: number;
}

export interface KbHydrationRow {
  rel_path: string;
  title: string;
  primary_theme: string;
  client_code: string;
  organization_name: string;
  content: string;
  modified_iso: string | null;
}

export interface KbArchiveIngestItem {
  id: string;
  relPath: string;
  filename: string;
  extension: string;
  topFolder: string;
  subFolder: string;
  modifiedIso: string;
  sourceType: string;
  primaryTheme: string;
  subThemes?: string;
  clientCode?: string;
  organizationName?: string;
  title: string;
  summaryPreview?: string;
  content: string;
}

const RRF_K = 60;
const DEFAULT_HALF_LIFE_DAYS = 30;
const MIN_LEADER_RERANK_SCORE = 0.15;

export function parseIsoToMs(iso?: string | null): number | null {
  if (!iso || typeof iso !== "string") return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const normalized =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
      ? `${trimmed}Z`
      : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTag(updatedAtMs: number, modifiedIso?: string | null): string {
  if (modifiedIso && /^\d{4}-\d{2}-\d{2}/.test(modifiedIso.trim())) {
    return modifiedIso.trim().slice(0, 10);
  }
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    return new Date(updatedAtMs).toISOString().slice(0, 10);
  }
  return "";
}

const FTS_STOPWORDS = new Set([
  "and",
  "or",
  "not",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "what",
  "how",
  "is",
  "in",
  "on",
  "of",
  "to",
  "at",
  "by",
  "as",
  "an",
  "be",
  "do",
  "it",
  "are",
  "was",
  "were",
  "into",
  "about"
]);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sanitizes natural language into a safe SQLite FTS5 query expression.
 */
export function buildSafeFts5Query(rawQuery: string): string {
  const tokens = rawQuery
    .replace(/[^\p{L}\p{N}_.\-/]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t.toLowerCase()));

  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Queries kb.tsimon.me's D1 database (archive-knowledge-db) and 768-dim Vectorize index (archive-kb-index)
 * concurrently at the Cloudflare edge.
 */
export async function queryKbArchive(
  env: Env,
  params: {
    query: string;
    namespace?: string;
    topK?: number;
  }
): Promise<{
  ftsResults: RankedCandidate[];
  vecResults: RankedCandidate[];
}> {
  const topK = params.topK ?? 12;
  const ftsQuery = buildSafeFts5Query(params.query);
  const kbEmbeddingModel =
    (env.KB_EMBEDDING_MODEL as "@cf/baai/bge-base-en-v1.5") ||
    "@cf/baai/bge-base-en-v1.5";

  // 1. Run 768-dim KB embedding + D1 FTS5 BM25 query (CTE + indexed files LEFT JOIN for modified_iso) in parallel
  const d1FtsPromise: Promise<{ results: KbFtsRow[] }> =
    ftsQuery !== '""' && env.KB_DB
      ? env.KB_DB.prepare(
          `WITH fts_hits AS (
             SELECT
               source_type,
               ref_id,
               rel_path,
               title,
               primary_theme,
               client_code,
               organization_name,
               substr(content, 1, 1600) AS content,
               (-1.0 * bm25(kb_fts, 1.0, 0.0, 4.0, 10.0, 3.0, 2.0, 3.0, 3.0, 2.0, 1.0)) AS fts_score
             FROM kb_fts
             WHERE kb_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2
           )
           SELECT
             h.source_type,
             h.ref_id,
             h.rel_path,
             h.title,
             h.primary_theme,
             h.client_code,
             h.organization_name,
             h.content,
             f.modified_iso AS modified_iso,
             h.fts_score
           FROM fts_hits h
           LEFT JOIN files f ON f.rel_path = h.rel_path
           ORDER BY h.fts_score DESC`
        )
          .bind(ftsQuery, topK)
          .all<KbFtsRow>()
          .catch(() => ({ results: [] as KbFtsRow[] }))
      : Promise.resolve({ results: [] as KbFtsRow[] });

  const kbVecMatchesPromise = (async () => {
    if (!env.KB_VECTORIZE || !env.AI) return { matches: [] as VectorizeMatch[] };
    try {
      const embRes = (await env.AI.run(kbEmbeddingModel, {
        text: [params.query]
      })) as { data: number[][] };
      const vector768 = embRes.data[0];
      if (!vector768) return { matches: [] as VectorizeMatch[] };
      // Note: archive-kb-index vectors have namespace = null, so we query globally across the KB index
      return await env.KB_VECTORIZE.query(vector768, {
        topK,
        returnMetadata: "all"
      });
    } catch {
      return { matches: [] as VectorizeMatch[] };
    }
  })();

  const [d1FtsResult, vecMatches] = await Promise.all([
    d1FtsPromise,
    kbVecMatchesPromise
  ]);

  const nowMs = Date.now();

  // 2. Transform D1 FTS5 rows into RankedCandidates keyed by canonical rel_path
  const ftsResults: RankedCandidate[] = (d1FtsResult.results ?? []).map((row) => {
    const canonicalKey = row.rel_path || `${row.source_type}:${row.ref_id}`;
    const themeLabel = row.primary_theme ? ` [${row.primary_theme}]` : "";
    const orgLabel = row.organization_name || row.client_code
      ? ` (${row.organization_name || row.client_code})`
      : "";
    const parsedModifiedMs = parseIsoToMs(row.modified_iso);
    return {
      id: canonicalKey,
      source: "kb_fts" as const,
      origin: "kb.tsimon.me" as const,
      title: `${row.title || row.rel_path}${themeLabel}${orgLabel}`,
      content: row.content || "",
      summary: (row.content || "").slice(0, 260),
      uri: `https://kb.tsimon.me/doc/${encodeURIComponent(canonicalKey)}`,
      namespace: row.client_code || "kb-archive",
      rawScore: Number(row.fts_score ?? 1.0),
      importance: 0.85,
      confidence: 1.0,
      updatedAtMs: parsedModifiedMs ?? nowMs,
      modifiedIso: row.modified_iso ?? null
    };
  });

  // 3. Hydrate KB Vectorize matches from D1 kb_fts / files using metadata.rel_path
  const rawMatches = vecMatches.matches ?? [];
  if (rawMatches.length === 0 || !env.KB_DB) {
    return { ftsResults, vecResults: [] };
  }

  const relPaths = Array.from(
    new Set(
      rawMatches
        .map((m) => String((m.metadata as Record<string, unknown> | undefined)?.rel_path ?? "").trim())
        .filter((p) => p.length > 0)
    )
  );

  const hydratedByRelPath = new Map<string, KbHydrationRow>();

  if (relPaths.length > 0) {
    const placeholders = relPaths.map((_, idx) => `?${idx + 1}`).join(", ");
    try {
      const hydrated = await env.KB_DB.prepare(
        `SELECT
           k.rel_path,
           k.title,
           k.primary_theme,
           k.client_code,
           k.organization_name,
           substr(k.content, 1, 1600) AS content,
           f.modified_iso AS modified_iso
         FROM kb_fts k
         LEFT JOIN files f ON f.rel_path = k.rel_path
         WHERE k.rel_path IN (${placeholders})`
      )
        .bind(...relPaths)
        .all<KbHydrationRow>();

      for (const row of hydrated.results ?? []) {
        if (row.rel_path && !hydratedByRelPath.has(row.rel_path)) {
          hydratedByRelPath.set(row.rel_path, row);
        }
      }
    } catch {
      // Non-fatal fallback to vector metadata if D1 hydration fails
    }
  }

  const vecResults: RankedCandidate[] = rawMatches.map((match) => {
    const meta = (match.metadata ?? {}) as Record<string, unknown>;
    const relPath = String(meta.rel_path ?? "").trim();
    const canonicalKey = relPath || match.id;
    const d1Row = relPath ? hydratedByRelPath.get(relPath) : undefined;

    const titleBase =
      d1Row?.title || String(meta.title ?? (relPath || match.id));
    const primaryTheme =
      d1Row?.primary_theme || String(meta.primary_theme ?? "");
    const clientCode =
      d1Row?.client_code || String(meta.client_code ?? "");
    const orgName = d1Row?.organization_name || "";

    const themeLabel = primaryTheme ? ` [${primaryTheme}]` : "";
    const orgLabel = orgName || clientCode ? ` (${orgName || clientCode})` : "";

    const contentText =
      d1Row?.content ||
      `Document: ${titleBase}\nPath: ${canonicalKey}\nTheme: ${primaryTheme || "General"}`;

    const parsedModifiedMs = parseIsoToMs(d1Row?.modified_iso);

    return {
      id: canonicalKey,
      source: "kb_vec" as const,
      origin: "kb.tsimon.me" as const,
      title: `${titleBase}${themeLabel}${orgLabel}`,
      content: contentText,
      summary: contentText.slice(0, 260),
      uri: `https://kb.tsimon.me/doc/${encodeURIComponent(canonicalKey)}`,
      namespace: clientCode || "kb-archive",
      rawScore: match.score,
      importance: 0.85,
      confidence: 1.0,
      updatedAtMs: parsedModifiedMs ?? nowMs,
      modifiedIso: d1Row?.modified_iso ?? null
    };
  });

  return { ftsResults, vecResults };
}

/**
 * Optional Cap'n Proto WorkerEntrypoint so external Workers in the same Cloudflare account
 * can also invoke KB Federation over zero-latency Service Bindings.
 */
export class KbFederationService extends WorkerEntrypoint<Env> {
  async searchKb(params: {
    query: string;
    namespace?: string;
    topK?: number;
  }): Promise<{
    ftsResults: RankedCandidate[];
    vecResults: RankedCandidate[];
  }> {
    return queryKbArchive(this.env, params);
  }
}

/**
 * 4-Way Weighted Reciprocal Rank Fusion (RRF) + Stage-2 Cross-Encoder Reranking combining:
 *   1. brain_fts (Durable Object SQLite FTS5 BM25)
 *   2. brain_vec (Cloudflare Vectorize 1024-dim @cf/baai/bge-m3 + KG Expansion)
 *   3. kb_fts    (D1 archive-knowledge-db kb_fts BM25)
 *   4. kb_vec    (Cloudflare Vectorize 768-dim @cf/baai/bge-base-en-v1.5)
 *   + Stage-2 Cross-Encoder Neural Reranker (@cf/baai/bge-reranker-base)
 */
export async function fuseBrainAndKb(params: {
  env?: Env;
  query?: string;
  brainFts: RankedCandidate[];
  brainVec: RankedCandidate[];
  kbFts: RankedCandidate[];
  kbVec: RankedCandidate[];
  activeDecisions?: string[];
  extraTriples?: Array<{ subject: string; predicate: string; object: string }>;
  tokenBudget: number;
  halfLifeDays?: number;
  explain?: boolean;
  weights?: {
    brain_fts: number;
    brain_vec: number;
    kb_fts: number;
    kb_vec: number;
  };
}): Promise<FusedContextResult> {
  const weights = params.weights ?? {
    brain_fts: 1.15,
    brain_vec: 1.15,
    kb_fts: 1.0,
    kb_vec: 1.05
  };

  type ChannelKey = "brain_fts" | "brain_vec" | "kb_fts" | "kb_vec";
  type FusedCandidate = RankedCandidate & {
    rrfScore: number;
    rawRrf: number;
    channelRanks: Partial<Record<ChannelKey, number>>;
    rerankScore?: number;
    sources: string[];
    explanation?: ScoreExplanation;
  };

  const merged = new Map<string, FusedCandidate>();

  const nowMs = Date.now();

  const ingestList = (
    list: RankedCandidate[],
    weight: number,
    sourceLabel: ChannelKey
  ) => {
    list.forEach((item, index) => {
      const rank = index + 1;
      const prefix = item.origin === "brain.tsimon.me" ? "brain" : "kb";
      const compositeId = `${prefix}:${item.id}`;
      const rrfContribution = weight / (RRF_K + rank);

      const existing = merged.get(compositeId);
      if (existing) {
        if (!existing.sources.includes(sourceLabel)) {
          existing.rrfScore += rrfContribution;
          existing.rawRrf += rrfContribution;
          existing.sources.push(sourceLabel);
          existing.channelRanks[sourceLabel] = rank;
        }
        if (item.triples && item.triples.length > 0) {
          existing.triples = [...(existing.triples ?? []), ...item.triples];
        }
      } else {
        merged.set(compositeId, {
          ...item,
          id: compositeId,
          rrfScore: rrfContribution,
          rawRrf: rrfContribution,
          channelRanks: { [sourceLabel]: rank },
          sources: [sourceLabel]
        });
      }
    });
  };

  ingestList(params.brainFts, weights.brain_fts, "brain_fts");
  ingestList(params.brainVec, weights.brain_vec, "brain_vec");
  ingestList(params.kbFts, weights.kb_fts, "kb_fts");
  ingestList(params.kbVec, weights.kb_vec, "kb_vec");

  // Apply Importance Boost, Bounded Epistemic Confidence & Configurable Half-Life Decay
  // (curated KB archive docs have decay = 1.0 so historical documents remain discoverable)
  const effectiveHalfLifeDays = Math.max(
    1,
    Math.min(365, params.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
  );
  const decayLambda = Math.LN2 / effectiveHalfLifeDays;

  const finalRanked: FusedCandidate[] = Array.from(merged.values()).map((doc) => {
    const ageDays = Math.max(0, (nowMs - doc.updatedAtMs) / 86_400_000);
    const decayFactor =
      doc.origin === "kb.tsimon.me" ? 1.0 : Math.exp(-decayLambda * ageDays);
    const importanceClamped = Math.max(0, Math.min(1, doc.importance ?? 0.5));
    const importanceBoost = 1.0 + 0.25 * importanceClamped;
    const confidenceClamped = Math.max(0, Math.min(1, doc.confidence ?? 1.0));
    const confidenceBoost = 0.75 + 0.25 * confidenceClamped;
    const score = doc.rawRrf * importanceBoost * confidenceBoost * decayFactor;

    return {
      ...doc,
      rrfScore: score,
      explanation: {
        channels: { ...doc.channelRanks },
        rawRrf: Number(doc.rawRrf.toFixed(6)),
        modifiers: {
          importance: Number(importanceClamped.toFixed(3)),
          importanceBoost: Number(importanceBoost.toFixed(4)),
          confidence: Number(confidenceClamped.toFixed(3)),
          confidenceBoost: Number(confidenceBoost.toFixed(4)),
          ageDays: Number(ageDays.toFixed(2)),
          halfLifeDays: effectiveHalfLifeDays,
          decayFactor: Number(decayFactor.toFixed(4))
        },
        finalScore: Number(score.toFixed(6))
      }
    };
  });

  finalRanked.sort((a, b) => b.rrfScore - a.rrfScore);

  // Stage-2 Cross-Encoder Neural Reranking (@cf/baai/bge-reranker-base) over Top-16 RRF Candidates
  let reranked = false;
  if (params.env?.AI && params.query && finalRanked.length > 1) {
    const rerankerModel =
      (params.env.RERANKER_MODEL as "@cf/baai/bge-reranker-base") ||
      "@cf/baai/bge-reranker-base";
    const poolSize = Math.min(16, finalRanked.length);
    const rerankPool = finalRanked.slice(0, poolSize);

    try {
      const rerankRes = (await params.env.AI.run(
        rerankerModel,
        {
          query: params.query,
          top_k: poolSize,
          contexts: rerankPool.map((doc) => ({
            text: `${doc.title}\n${doc.content.slice(0, 900)}`
          }))
        } as never
      )) as {
        response?: Array<{ id?: number; score?: number }>;
        data?: Array<{ id?: number; score?: number }>;
      };

      const rawScores = rerankRes?.response ?? rerankRes?.data ?? [];
      if (rawScores.length > 0) {
        const validScores = rawScores
          .map((r) => (typeof r.score === "number" ? r.score : null))
          .filter((s): s is number => s !== null && Number.isFinite(s));

        if (validScores.length > 0) {
          const minScore = Math.min(...validScores);
          const maxScore = Math.max(...validScores);
          const span = maxScore - minScore;

          for (const item of rawScores) {
            if (
              typeof item.id === "number" &&
              item.id >= 0 &&
              item.id < rerankPool.length &&
              typeof item.score === "number" &&
              Number.isFinite(item.score)
            ) {
              const candidate = rerankPool[item.id];
              candidate.rerankScore = item.score;
              const normScore =
                span > 1e-6
                  ? (item.score - minScore) / span
                  : Math.max(0, Math.min(1, item.score));
              const rerankBoost = 1.0 + 0.55 * normScore;
              candidate.rrfScore = candidate.rrfScore * rerankBoost;
              if (candidate.explanation) {
                candidate.explanation.modifiers.rerankRawScore = Number(item.score.toFixed(4));
                candidate.explanation.modifiers.rerankBoost = Number(rerankBoost.toFixed(4));
                candidate.explanation.finalScore = Number(candidate.rrfScore.toFixed(6));
              }
            }
          }

          finalRanked.sort((a, b) => b.rrfScore - a.rrfScore);
          reranked = true;
        }
      }
    } catch {
      // Non-fatal fallback to Stage-1 4-way RRF ranking if Cross-Encoder invocation fails
    }
  }

  // Assemble Token-Budgeted <brain_context> XML Block
  let usedTokens = 0;
  const sections: string[] = [];

  // 1. Pack Active Architectural Decisions (ADRs) individually up to 25% of tokenBudget
  //    (never drop all ADRs when the combined list exceeds the cap)
  if (params.activeDecisions && params.activeDecisions.length > 0) {
    const adrCap = Math.floor(params.tokenBudget * 0.25);
    const adrHeader = "### Active Architectural Decisions (ADRs)";
    const headerTokens = estimateTokens(adrHeader);
    let adrTokens = headerTokens;
    const packedAdrs: string[] = [];

    for (const rawLine of params.activeDecisions) {
      const line = rawLine.trim();
      if (!line) continue;
      const lineTokens = estimateTokens(`\n${line}`);
      if (usedTokens + adrTokens + lineTokens <= adrCap) {
        packedAdrs.push(line);
        adrTokens += lineTokens;
      } else if (packedAdrs.length === 0) {
        // Fit at least the #1 highest-priority ADR truncated cleanly within adrCap
        const availTokens = adrCap - usedTokens - adrTokens - 2;
        if (availTokens >= 20) {
          const maxChars = availTokens * 4;
          const truncated =
            line.length > maxChars ? `${line.slice(0, Math.max(20, maxChars - 3))}...` : line;
          const truncTokens = estimateTokens(`\n${truncated}`);
          if (usedTokens + adrTokens + truncTokens <= adrCap) {
            packedAdrs.push(truncated);
            adrTokens += truncTokens;
          }
        }
        break;
      }
    }

    if (packedAdrs.length > 0) {
      sections.push(`${adrHeader}\n${packedAdrs.join("\n")}`);
      usedTokens += adrTokens;
    }
  }

  // 2. Collect and pack unique 1-Hop Knowledge Graph Triples individually up to 45% cumulative budget
  const uniqueTriples = new Set<string>();
  for (const t of params.extraTriples ?? []) {
    uniqueTriples.add(`(${t.subject}) --[${t.predicate}]--> (${t.object})`);
  }
  for (const doc of finalRanked) {
    for (const t of doc.triples ?? []) {
      uniqueTriples.add(`(${t.subject}) --[${t.predicate}]--> (${t.object})`);
    }
  }

  let graphTriplesCount = 0;
  if (uniqueTriples.size > 0) {
    const kgCap = Math.floor(params.tokenBudget * 0.45);
    const kgHeader = "### Connected Knowledge Graph Triples (1-Hop)";
    let kgTokens = estimateTokens(kgHeader);
    const packedTriples: string[] = [];

    for (const triple of Array.from(uniqueTriples).slice(0, 15)) {
      const line = `- ${triple}`;
      const lineTokens = estimateTokens(`\n${line}`);
      if (usedTokens + kgTokens + lineTokens <= kgCap) {
        packedTriples.push(line);
        kgTokens += lineTokens;
      } else {
        break;
      }
    }

    if (packedTriples.length > 0) {
      sections.push(`${kgHeader}\n${packedTriples.join("\n")}`);
      usedTokens += kgTokens;
      graphTriplesCount = packedTriples.length;
    }
  }

  // 3. Pack Fused Chunks (Brain + KB) within remaining token budget
  // Guarantee representation from both Brain and KB when both have hits so neither pool starves the other
  const selectedCandidates: FusedCandidate[] = [];
  const chunkLines: string[] = [];
  let brainCount = 0;
  let kbCount = 0;

  // When Stage-2 Cross-Encoder reranking succeeded, trust the reranker and only guarantee
  // the #1 post-rerank Brain & KB winners if their reranker score clears MIN_LEADER_RERANK_SCORE,
  // preventing near-zero-relevance cross-origin noise (e.g., rerank=0.003) from hijacking slot #2.
  // Low-scoring hits still remain in finalRanked at their natural score.
  // When reranking is unavailable, fall back to guaranteeing #1 from each of the 4 signal channels.
  const findById = (prefix: "brain" | "kb", rawId?: string) =>
    rawId ? finalRanked.find((d) => d.id === `${prefix}:${rawId}`) : undefined;

  const topRerankedBrain = finalRanked.find(
    (d) => d.origin === "brain.tsimon.me"
  );
  const topRerankedKb = finalRanked.find((d) => d.origin === "kb.tsimon.me");

  const passesLeaderFloor = (doc?: FusedCandidate) =>
    Boolean(
      doc &&
        typeof doc.rerankScore === "number" &&
        doc.rerankScore >= MIN_LEADER_RERANK_SCORE
    );

  const topSignalLeaders = (
    reranked
      ? [
          passesLeaderFloor(topRerankedBrain) ? topRerankedBrain : undefined,
          passesLeaderFloor(topRerankedKb) ? topRerankedKb : undefined
        ]
      : [
          topRerankedBrain,
          topRerankedKb,
          findById("brain", params.brainFts[0]?.id),
          findById("brain", params.brainVec[0]?.id),
          findById("kb", params.kbFts[0]?.id),
          findById("kb", params.kbVec[0]?.id)
        ]
  ).filter((d): d is NonNullable<typeof d> => Boolean(d));

  const orderedQueue: FusedCandidate[] = [];
  const queuedIds = new Set<string>();

  for (const leader of topSignalLeaders) {
    if (!queuedIds.has(leader.id)) {
      orderedQueue.push(leader);
      queuedIds.add(leader.id);
    }
  }
  for (const doc of finalRanked) {
    if (!queuedIds.has(doc.id)) {
      orderedQueue.push(doc);
      queuedIds.add(doc.id);
    }
  }

  const maxFullBodyChars = params.tokenBudget <= 1800 ? 750 : 1200;

  orderedQueue.forEach((doc, idx) => {
    const badge =
      doc.origin === "kb.tsimon.me"
        ? "[KB]"
        : doc.memoryType === "episodic_summary"
          ? "[BRAIN] [DIGEST]"
          : "[BRAIN]";
    const rawBody =
      idx < 5
        ? doc.content
        : doc.summary || doc.content.slice(0, 280);
    const fullBody =
      rawBody.length > maxFullBodyChars
        ? `${rawBody.slice(0, maxFullBodyChars)}...`
        : rawBody;

    const rerankTag =
      typeof doc.rerankScore === "number"
        ? ` | Rerank: ${doc.rerankScore.toFixed(3)}`
        : "";
    const dateVal = formatDateTag(doc.updatedAtMs, doc.modifiedIso);
    const dateTag = dateVal ? ` | date: ${dateVal}` : "";
    const entry = `#### ${badge} ${doc.title} (RRF: ${doc.rrfScore.toFixed(4)}${rerankTag}${dateTag} | via: ${doc.sources.join("+")} | uri: ${doc.uri})\n${fullBody}`;
    const entryTokens = estimateTokens(entry);

    if (usedTokens + entryTokens <= params.tokenBudget) {
      chunkLines.push(entry);
      usedTokens += entryTokens;
      if (doc.explanation) doc.explanation.packedMode = "full";
      selectedCandidates.push(doc);
      if (doc.origin === "kb.tsimon.me") {
        kbCount++;
      } else {
        brainCount++;
      }
      return;
    }

    // Try condensed fallback if full text exceeds remaining budget
    const condensedBody = (doc.summary || doc.content).slice(0, 220);
    const condensedEntry = `- **${badge} ${doc.title}** (${doc.uri}, RRF: ${doc.rrfScore.toFixed(4)}${rerankTag}${dateTag}): ${condensedBody}`;
    const condensedTokens = estimateTokens(condensedEntry);
    if (usedTokens + condensedTokens <= params.tokenBudget) {
      chunkLines.push(condensedEntry);
      usedTokens += condensedTokens;
      if (doc.explanation) doc.explanation.packedMode = "condensed";
      selectedCandidates.push(doc);
      if (doc.origin === "kb.tsimon.me") {
        kbCount++;
      } else {
        brainCount++;
      }
    }
  });

  if (chunkLines.length > 0) {
    sections.push(
      `### Federated Recalled Context (${brainCount} Brain, ${kbCount} KB)\n${chunkLines.join("\n\n")}`
    );
  }

  let contextBlock = `<brain_context federated="true" reranked="${reranked}" tokens_used="${usedTokens}" token_budget="${params.tokenBudget}" brain_matches="${brainCount}" kb_matches="${kbCount}">\n${sections.join("\n\n")}\n</brain_context>`;

  if (params.explain) {
    const explainLines = selectedCandidates.map((doc, idx) => {
      const exp = doc.explanation;
      const chStr = exp
        ? Object.entries(exp.channels)
            .map(([k, r]) => `${k}=#${r}`)
            .join(", ")
        : doc.sources.join(", ");
      const modStr = exp
        ? `rawRrf=${exp.rawRrf.toFixed(5)} | imp=${exp.modifiers.importance} (x${exp.modifiers.importanceBoost}) | conf=${exp.modifiers.confidence} (x${exp.modifiers.confidenceBoost}) | decay=${exp.modifiers.decayFactor} (age=${exp.modifiers.ageDays}d, hl=${exp.modifiers.halfLifeDays}d)` +
          (exp.modifiers.rerankRawScore !== undefined
            ? ` | rerank=${exp.modifiers.rerankRawScore} (x${exp.modifiers.rerankBoost})`
            : "") +
          ` | mode=${exp.packedMode || "full"}`
        : "";
      return `${idx + 1}. \`${doc.id}\` -> final=${doc.rrfScore.toFixed(5)} | channels=[${chStr}] | ${modStr}`;
    });
    contextBlock +=
      `\n\n<recall_explanation half_life_days="${effectiveHalfLifeDays}" reranked="${reranked}" total_candidates_fused="${finalRanked.length}" packed="${selectedCandidates.length}">\n` +
      explainLines.join("\n") +
      `\n</recall_explanation>`;
  }

  return {
    contextBlock,
    totalTokens: usedTokens,
    tokenBudget: params.tokenBudget,
    selectedCount: selectedCandidates.length,
    brainCount,
    kbCount,
    graphTriplesCount,
    reranked,
    candidates: selectedCandidates.map(({ rawRrf: _rawRrf, channelRanks: _channelRanks, ...rest }) => rest)
  };
}

/**
 * Batch-ingests Long-Term Archive documents into D1 (archive-knowledge-db: files + kb_fts)
 * and Vectorize (archive-kb-index: 768-dim @cf/baai/bge-base-en-v1.5).
 */
export async function ingestKbArchiveBatch(
  env: Env,
  items: KbArchiveIngestItem[]
): Promise<{
  ingestedD1: number;
  indexedVectors: number;
  ids: string[];
}> {
  if (!items || items.length === 0) {
    return { ingestedD1: 0, indexedVectors: 0, ids: [] };
  }

  const kbEmbeddingModel =
    (env.KB_EMBEDDING_MODEL as "@cf/baai/bge-base-en-v1.5") ||
    "@cf/baai/bge-base-en-v1.5";
  const nowIso = new Date().toISOString();

  // 1. Batch-upsert into D1 (files + kb_fts)
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    const sizeBytes = new TextEncoder().encode(item.content).length;
    const summaryPreview =
      item.summaryPreview || item.content.slice(0, 320).replace(/\s+/g, " ").trim();
    const subThemes = item.subThemes || "[]";
    const clientCode = item.clientCode || "";
    const orgName = item.organizationName || "";

    statements.push(
      env.KB_DB.prepare(
        `INSERT INTO files (
          rel_path, filename, extension, top_folder, sub_folder, size_bytes,
          modified_iso, status, primary_theme, all_themes, sub_themes,
          client_code, organization_name, tickets, title_or_subject,
          summary_preview, extracted_text, custom_tags, curated_notes, starred, last_updated
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'indexed', ?8, ?9, ?10, ?11, ?12, '', ?13, ?14, ?15, '["google-takeout"]', '', 0, ?16)
        ON CONFLICT(rel_path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          modified_iso = excluded.modified_iso,
          primary_theme = excluded.primary_theme,
          sub_themes = excluded.sub_themes,
          title_or_subject = excluded.title_or_subject,
          summary_preview = excluded.summary_preview,
          extracted_text = excluded.extracted_text,
          last_updated = excluded.last_updated`
      ).bind(
        item.relPath,
        item.filename,
        item.extension,
        item.topFolder,
        item.subFolder,
        sizeBytes,
        item.modifiedIso,
        item.primaryTheme,
        JSON.stringify([item.primaryTheme]),
        subThemes,
        clientCode,
        orgName,
        item.title,
        summaryPreview,
        item.content,
        nowIso
      )
    );

    // Ensure idempotent FTS5 replacement by rel_path
    statements.push(
      env.KB_DB.prepare(`DELETE FROM kb_fts WHERE rel_path = ?1`).bind(item.relPath)
    );

    statements.push(
      env.KB_DB.prepare(
        `INSERT INTO kb_fts (
          source_type, ref_id, rel_path, title, primary_theme,
          sub_themes, client_code, organization_name, tickets, content
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9)`
      ).bind(
        item.sourceType,
        item.id,
        item.relPath,
        item.title,
        item.primaryTheme,
        subThemes,
        clientCode,
        orgName,
        item.content
      )
    );
  }

  await env.KB_DB.batch(statements);

  // 2. Generate 768-dim dense vectors in a single Workers AI batch call & upsert into archive-kb-index
  const texts = items.map(
    (item) => `${item.title}\nTheme: ${item.primaryTheme}\n${item.content.slice(0, 3200)}`
  );
  const embRes = (await env.AI.run(kbEmbeddingModel, {
    text: texts
  })) as { data: number[][] };

  const vectorRecords: VectorizeVector[] = [];
  items.forEach((item, idx) => {
    const values = embRes.data?.[idx];
    if (values && values.length === 768) {
      vectorRecords.push({
        id: item.id.slice(0, 64),
        values,
        metadata: {
          rel_path: item.relPath,
          title: item.title,
          primary_theme: item.primaryTheme,
          client_code: item.clientCode || "",
          source_type: item.sourceType
        }
      });
    }
  });

  if (vectorRecords.length > 0) {
    await env.KB_VECTORIZE.upsert(vectorRecords);
  }

  return {
    ingestedD1: items.length,
    indexedVectors: vectorRecords.length,
    ids: items.map((i) => i.id)
  };
}

/**
 * Re-embeds and upserts specific KB Vectorize records (archive-kb-index, 768-dim @cf/baai/bge-base-en-v1.5)
 * directly from the current D1 kb_fts / files rows while preserving exact canonical vector IDs
 * ('file:<id>' for files rows, or exact ref_id for takeout/archive records).
 */
export async function reindexKbVectors(
  env: Env,
  vectorIds: string[]
): Promise<{
  ok: boolean;
  requested: number;
  reindexedVectors: number;
  ids: string[];
}> {
  const uniqueIds = Array.from(
    new Set((vectorIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  ).slice(0, 64);

  if (uniqueIds.length === 0 || !env.KB_DB || !env.KB_VECTORIZE || !env.AI) {
    return { ok: true, requested: uniqueIds.length, reindexedVectors: 0, ids: [] };
  }

  const refIds = uniqueIds.map((vid) => (vid.startsWith("file:") ? vid.slice(5) : vid));
  const placeholders = refIds.map((_, i) => `?${i + 1}`).join(", ");
  const ftsRes = await env.KB_DB.prepare(
    `SELECT source_type, ref_id, rel_path, title, primary_theme, sub_themes, client_code, organization_name, tickets, content
     FROM kb_fts
     WHERE ref_id IN (${placeholders})`
  )
    .bind(...refIds)
    .all<{
      source_type: string;
      ref_id: string;
      rel_path: string;
      title: string;
      primary_theme: string;
      sub_themes: string;
      client_code: string;
      organization_name: string;
      tickets: string;
      content: string;
    }>();

  const byRefId = new Map<string, (typeof ftsRes.results)[number]>();
  for (const row of ftsRes.results ?? []) {
    if (row.ref_id && !byRefId.has(row.ref_id)) {
      byRefId.set(row.ref_id, row);
    }
  }

  const targets: Array<{ vectorId: string; row: (typeof ftsRes.results)[number] }> = [];
  for (const vid of uniqueIds) {
    const rid = vid.startsWith("file:") ? vid.slice(5) : vid;
    const row = byRefId.get(rid);
    if (row) targets.push({ vectorId: vid, row });
  }

  if (targets.length === 0) {
    return { ok: true, requested: uniqueIds.length, reindexedVectors: 0, ids: [] };
  }

  const kbEmbeddingModel =
    (env.KB_EMBEDDING_MODEL as "@cf/baai/bge-base-en-v1.5") ||
    "@cf/baai/bge-base-en-v1.5";

  const texts = targets.map(
    ({ row }) => `${row.title}\nTheme: ${row.primary_theme}\n${(row.content || "").slice(0, 3200)}`
  );
  const embRes = (await env.AI.run(kbEmbeddingModel, { text: texts })) as {
    data?: number[][];
  };

  const vectorRecords: VectorizeVector[] = [];
  targets.forEach(({ vectorId, row }, idx) => {
    const values = embRes.data?.[idx];
    if (values && values.length === 768) {
      vectorRecords.push({
        id: vectorId.slice(0, 64),
        values,
        metadata: {
          rel_path: row.rel_path || "",
          title: (row.title || "").slice(0, 500),
          primary_theme: row.primary_theme || "",
          sub_themes: row.sub_themes || "[]",
          client_code: row.client_code || "",
          organization_name: row.organization_name || "",
          source_type: row.source_type || "document",
          tickets: row.tickets || "",
          preview: (row.content || "").slice(0, 260).replace(/\s+/g, " ").trim()
        }
      });
    }
  });

  if (vectorRecords.length > 0) {
    await env.KB_VECTORIZE.upsert(vectorRecords);
  }

  return {
    ok: true,
    requested: uniqueIds.length,
    reindexedVectors: vectorRecords.length,
    ids: vectorRecords.map((v) => v.id)
  };
}
