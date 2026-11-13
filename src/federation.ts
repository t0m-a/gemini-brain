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
  title: string;
  content: string;
  summary?: string | null;
  uri: string;
  namespace: string;
  rawScore: number;
  importance: number; // 0.0 to 1.0
  updatedAtMs: number;
  triples?: Array<{ subject: string; predicate: string; object: string }>;
}

export interface FusedContextResult {
  contextBlock: string;
  totalTokens: number;
  tokenBudget: number;
  selectedCount: number;
  brainCount: number;
  kbCount: number;
  graphTriplesCount: number;
  candidates: Array<RankedCandidate & { rrfScore: number; sources: string[] }>;
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
const DECAY_LAMBDA = 0.015; // ~46-day half-life for episodic decay

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

  // 1. Run 768-dim KB embedding + D1 FTS5 BM25 query in parallel
  const d1FtsPromise: Promise<{ results: KbFtsRow[] }> =
    ftsQuery !== '""' && env.KB_DB
      ? env.KB_DB.prepare(
          `SELECT
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
           LIMIT ?2`
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
      updatedAtMs: nowMs
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
           rel_path,
           title,
           primary_theme,
           client_code,
           organization_name,
           substr(content, 1, 1600) AS content,
           NULL AS modified_iso
         FROM kb_fts
         WHERE rel_path IN (${placeholders})`
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
      updatedAtMs: nowMs
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
 * 4-Way Weighted Reciprocal Rank Fusion (RRF) combining:
 *   1. brain_fts (Durable Object SQLite FTS5 BM25)
 *   2. brain_vec (Cloudflare Vectorize 1024-dim @cf/baai/bge-m3 + KG Expansion)
 *   3. kb_fts    (D1 archive-knowledge-db kb_fts BM25)
 *   4. kb_vec    (Cloudflare Vectorize 768-dim @cf/baai/bge-base-en-v1.5)
 */
export function fuseBrainAndKb(params: {
  brainFts: RankedCandidate[];
  brainVec: RankedCandidate[];
  kbFts: RankedCandidate[];
  kbVec: RankedCandidate[];
  activeDecisions?: string[];
  extraTriples?: Array<{ subject: string; predicate: string; object: string }>;
  tokenBudget: number;
  weights?: {
    brain_fts: number;
    brain_vec: number;
    kb_fts: number;
    kb_vec: number;
  };
}): FusedContextResult {
  const weights = params.weights ?? {
    brain_fts: 1.15,
    brain_vec: 1.15,
    kb_fts: 1.0,
    kb_vec: 1.05
  };

  const merged = new Map<
    string,
    RankedCandidate & { rrfScore: number; sources: string[] }
  >();

  const nowMs = Date.now();

  const ingestList = (
    list: RankedCandidate[],
    weight: number,
    sourceLabel: string
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
          existing.sources.push(sourceLabel);
        }
        if (item.triples && item.triples.length > 0) {
          existing.triples = [...(existing.triples ?? []), ...item.triples];
        }
      } else {
        merged.set(compositeId, {
          ...item,
          id: compositeId,
          rrfScore: rrfContribution,
          sources: [sourceLabel]
        });
      }
    });
  };

  ingestList(params.brainFts, weights.brain_fts, "brain_fts");
  ingestList(params.brainVec, weights.brain_vec, "brain_vec");
  ingestList(params.kbFts, weights.kb_fts, "kb_fts");
  ingestList(params.kbVec, weights.kb_vec, "kb_vec");

  // Apply Importance Boost & Temporal Decay (curated KB docs have decay = 1.0)
  const finalRanked = Array.from(merged.values()).map((doc) => {
    const ageDays = Math.max(0, (nowMs - doc.updatedAtMs) / 86_400_000);
    const decayFactor =
      doc.origin === "kb.tsimon.me" ? 1.0 : Math.exp(-DECAY_LAMBDA * ageDays);
    const importanceBoost = 1.0 + 0.25 * (doc.importance ?? 0.5);

    return {
      ...doc,
      rrfScore: doc.rrfScore * importanceBoost * decayFactor
    };
  });

  finalRanked.sort((a, b) => b.rrfScore - a.rrfScore);

  // Assemble Token-Budgeted <brain_context> XML Block
  let usedTokens = 0;
  const sections: string[] = [];

  // 1. Always inject Active Architectural Decisions (ADRs) first if present
  if (params.activeDecisions && params.activeDecisions.length > 0) {
    const adrBlock = `### Active Architectural Decisions (ADRs)\n${params.activeDecisions.join("\n")}`;
    const adrTokens = estimateTokens(adrBlock);
    if (usedTokens + adrTokens <= Math.floor(params.tokenBudget * 0.25)) {
      sections.push(adrBlock);
      usedTokens += adrTokens;
    }
  }

  // 2. Collect unique 1-Hop Knowledge Graph Triples
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
    const tripleSlice = Array.from(uniqueTriples).slice(0, 15);
    const kgBlock = `### Connected Knowledge Graph Triples (1-Hop)\n${tripleSlice
      .map((t) => `- ${t}`)
      .join("\n")}`;
    const kgTokens = estimateTokens(kgBlock);
    if (usedTokens + kgTokens <= Math.floor(params.tokenBudget * 0.45)) {
      sections.push(kgBlock);
      usedTokens += kgTokens;
      graphTriplesCount = tripleSlice.length;
    }
  }

  // 3. Pack Fused Chunks (Brain + KB) within remaining token budget
  // Guarantee representation from both Brain and KB when both have hits so neither pool starves the other
  const selectedCandidates: Array<
    RankedCandidate & { rrfScore: number; sources: string[] }
  > = [];
  const chunkLines: string[] = [];
  let brainCount = 0;
  let kbCount = 0;

  // Guarantee the true #1 rank from each of the 4 signal lists (brainFts[0], brainVec[0], kbFts[0], kbVec[0])
  // is placed at the front of the packing queue before remaining RRF-sorted candidates
  const findById = (prefix: "brain" | "kb", rawId?: string) =>
    rawId ? finalRanked.find((d) => d.id === `${prefix}:${rawId}`) : undefined;

  const topSignalLeaders = [
    findById("brain", params.brainFts[0]?.id),
    findById("brain", params.brainVec[0]?.id),
    findById("kb", params.kbFts[0]?.id),
    findById("kb", params.kbVec[0]?.id)
  ].filter((d): d is NonNullable<typeof d> => Boolean(d));

  const orderedQueue: Array<
    RankedCandidate & { rrfScore: number; sources: string[] }
  > = [];
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
    const badge = doc.origin === "kb.tsimon.me" ? "[KB]" : "[BRAIN]";
    const rawBody =
      idx < 5
        ? doc.content
        : doc.summary || doc.content.slice(0, 280);
    const fullBody =
      rawBody.length > maxFullBodyChars
        ? `${rawBody.slice(0, maxFullBodyChars)}...`
        : rawBody;

    const entry = `#### ${badge} ${doc.title} (RRF: ${doc.rrfScore.toFixed(4)} | via: ${doc.sources.join("+")} | uri: ${doc.uri})\n${fullBody}`;
    const entryTokens = estimateTokens(entry);

    if (usedTokens + entryTokens <= params.tokenBudget) {
      chunkLines.push(entry);
      usedTokens += entryTokens;
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
    const condensedEntry = `- **${badge} ${doc.title}** (${doc.uri}, RRF: ${doc.rrfScore.toFixed(4)}): ${condensedBody}`;
    const condensedTokens = estimateTokens(condensedEntry);
    if (usedTokens + condensedTokens <= params.tokenBudget) {
      chunkLines.push(condensedEntry);
      usedTokens += condensedTokens;
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

  const contextBlock = `<brain_context federated="true" tokens_used="${usedTokens}" token_budget="${params.tokenBudget}" brain_matches="${brainCount}" kb_matches="${kbCount}">\n${sections.join("\n\n")}\n</brain_context>`;

  return {
    contextBlock,
    totalTokens: usedTokens,
    tokenBudget: params.tokenBudget,
    selectedCount: selectedCandidates.length,
    brainCount,
    kbCount,
    graphTriplesCount,
    candidates: selectedCandidates
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
