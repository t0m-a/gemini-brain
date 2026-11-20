import { describe, it, expect } from "vitest";
import {
  buildSafeFts5Query,
  estimateTokens,
  fuseBrainAndKb,
  parseIsoToMs,
  type RankedCandidate
} from "../src/federation";
import type { Env } from "../src/memory-do";

function makeCandidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  return {
    id: "mem-1",
    source: "brain_fts",
    origin: "brain.tsimon.me",
    title: "[homelab] WireGuard Port",
    content: "Raspberry Pi 5 WireGuard VPN listens on UDP 51820.",
    uri: "brain://homelab/mem-1",
    namespace: "homelab",
    rawScore: 5.0,
    importance: 0.7,
    confidence: 1.0,
    updatedAtMs: Date.now(),
    ...overrides
  };
}

describe("FTS5 sanitization, token estimation & ISO timestamp parsing", () => {
  it("sanitizes unsafe FTS5 syntax, punctuation, and stopwords", () => {
    const q = buildSafeFts5Query('What is the "WireGuard": port (UDP/51820) AND rpi5-hub?');
    expect(q).toBe('"WireGuard" OR "port" OR "UDP/51820" OR "rpi5-hub"');
    expect(q).not.toContain('"the"');
    expect(q).not.toContain('"and"');
  });

  it("handles empty or stopword-only queries safely", () => {
    expect(buildSafeFts5Query("   ")).toBe('""');
    expect(buildSafeFts5Query("the and or for")).toBe('""');
    expect(buildSafeFts5Query("a b !@#$%^&*()")).toBe('""');
  });

  it("preserves accented Unicode words and technical identifiers", () => {
    const q = buildSafeFts5Query("configuración_red brain.tsimon.me adr_782e50f6");
    expect(q).toBe('"configuración_red" OR "brain.tsimon.me" OR "adr_782e50f6"');
  });

  it("estimates tokens at ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("parses D1 modified_iso formats with or without Z timezone suffix", () => {
    const msNoTz = parseIsoToMs("2025-02-20T13:10:16");
    expect(msNoTz).not.toBeNull();
    expect(new Date(msNoTz!).toISOString()).toBe("2025-02-20T13:10:16.000Z");

    const msWithTz = parseIsoToMs("2026-10-27T01:27:59Z");
    expect(msWithTz).toBe(Date.parse("2026-10-27T01:27:59Z"));

    expect(parseIsoToMs("")).toBeNull();
    expect(parseIsoToMs(null)).toBeNull();
    expect(parseIsoToMs("not-a-date")).toBeNull();
  });
});

describe("fuseBrainAndKb() ranking, decay, confidence, reranking & token packing", () => {
  it("applies configurable halfLifeDays exact exponential decay to Brain memories", async () => {
    const nowMs = Date.now();
    const thirtyDaysAgoMs = nowMs - 30 * 86_400_000;
    const oldMem = makeCandidate({ id: "aged", updatedAtMs: thirtyDaysAgoMs });

    const r30 = await fuseBrainAndKb({
      brainFts: [oldMem],
      brainVec: [],
      kbFts: [],
      kbVec: [],
      tokenBudget: 1500,
      halfLifeDays: 30
    });
    const r365 = await fuseBrainAndKb({
      brainFts: [oldMem],
      brainVec: [],
      kbFts: [],
      kbVec: [],
      tokenBudget: 1500,
      halfLifeDays: 365
    });

    const ratio = r30.candidates[0].rrfScore / r365.candidates[0].rrfScore;
    // exp(-ln2 * 30 / 30) / exp(-ln2 * 30 / 365) = 0.5 / 0.94462 = 0.5293
    expect(ratio).toBeGreaterThan(0.51);
    expect(ratio).toBeLessThan(0.55);
  });

  it("applies bounded confidence modifier (0.75 to 1.0) without crushing exact hits", async () => {
    const nowMs = Date.now();
    const highConf = makeCandidate({ id: "high-c", confidence: 1.0, updatedAtMs: nowMs });
    const lowConf = makeCandidate({ id: "low-c", confidence: 0.0, updatedAtMs: nowMs });

    const res = await fuseBrainAndKb({
      brainFts: [lowConf],
      brainVec: [highConf],
      kbFts: [],
      kbVec: [],
      tokenBudget: 1500
    });

    expect(res.candidates[0].id).toBe("brain:high-c");
    const scoreRatio = res.candidates[1].rrfScore / res.candidates[0].rrfScore;
    expect(scoreRatio).toBeCloseTo(0.75, 2);
  });

  it("keeps curated KB archive decay = 1.0 while surfacing hydrated date: YYYY-MM-DD", async () => {
    const oldKb = makeCandidate({
      id: "Docs/Veeam-2020.md",
      source: "kb_fts",
      origin: "kb.tsimon.me",
      title: "Legacy Veeam Assessment",
      content: "Retention policy is 30 days.",
      uri: "https://kb.tsimon.me/doc/Docs%2FVeeam-2020.md",
      updatedAtMs: parseIsoToMs("2020-08-14T15:48:34")!,
      modifiedIso: "2020-08-14T15:48:34"
    });
    const freshKb = makeCandidate({
      id: "Docs/Veeam-2026.md",
      source: "kb_vec",
      origin: "kb.tsimon.me",
      title: "Recent Veeam Assessment",
      content: "Retention policy is 30 days.",
      uri: "https://kb.tsimon.me/doc/Docs%2FVeeam-2026.md",
      updatedAtMs: parseIsoToMs("2026-10-27T01:26:36")!,
      modifiedIso: "2026-10-27T01:26:36"
    });

    const res = await fuseBrainAndKb({
      brainFts: [],
      brainVec: [],
      kbFts: [oldKb],
      kbVec: [freshKb],
      tokenBudget: 1500,
      halfLifeDays: 10
    });

    expect(res.contextBlock).toContain("| date: 2020-08-14");
    expect(res.contextBlock).toContain("| date: 2026-10-27");
    // Despite 6-year age gap, kb_fts (weight 1.0) vs kb_vec (weight 1.05) should have zero age decay difference
    const oldCand = res.candidates.find((c) => c.id === "kb:Docs/Veeam-2020.md")!;
    const freshCand = res.candidates.find((c) => c.id === "kb:Docs/Veeam-2026.md")!;
    expect(oldCand.rrfScore / freshCand.rrfScore).toBeCloseTo(1.0 / 1.05, 2);
  });

  it("lets Stage-2 cross-encoder reranker override raw pre-rerank #1 lexical noise", async () => {
    const nowMs = Date.now();
    const noisyRawFirst = makeCandidate({ id: "noisy-1", title: "Noisy FTS Hit", updatedAtMs: nowMs });
    const trueAnswer = makeCandidate({ id: "true-2", title: "True Answer", updatedAtMs: nowMs });

    const mockEnv = {
      AI: {
        async run() {
          return {
            response: [
              { id: 0, score: 0.02 },
              { id: 1, score: 0.98 }
            ]
          };
        }
      }
    } as unknown as Env;

    const res = await fuseBrainAndKb({
      env: mockEnv,
      query: "exact question",
      brainFts: [noisyRawFirst, trueAnswer],
      brainVec: [],
      kbFts: [],
      kbVec: [],
      tokenBudget: 1500
    });

    expect(res.reranked).toBe(true);
    expect(res.candidates[0].id).toBe("brain:true-2");
  });

  it("enforces tokenBudget caps across ADRs (<=25%), KG (<=45%), and condensed chunk fallbacks", async () => {
    const nowMs = Date.now();
    const longContent = "X".repeat(1600); // ~400 tokens each
    const candidates = Array.from({ length: 8 }, (_, idx) =>
      makeCandidate({
        id: `long-${idx}`,
        title: `Long Memory ${idx}`,
        content: longContent,
        summary: `Short summary for memory ${idx}.`,
        updatedAtMs: nowMs
      })
    );

    const budget = 600;
    const res = await fuseBrainAndKb({
      brainFts: candidates,
      brainVec: [],
      kbFts: [],
      kbVec: [],
      activeDecisions: ["- **[adr_01] Rule**: Always keep budgets strict."],
      extraTriples: [
        { subject: "Raspberry Pi 5", predicate: "EXPOSES_PORT", object: "WireGuard UDP 51820" }
      ],
      tokenBudget: budget
    });

    expect(res.totalTokens).toBeLessThanOrEqual(budget);
    expect(res.contextBlock).toContain("Active Architectural Decisions");
    expect(res.contextBlock).toContain("Connected Knowledge Graph Triples");
    expect(res.selectedCount).toBeGreaterThan(0);
    // Tight budget should force condensed bullet fallback for later items
    expect(res.contextBlock).toContain("- **[BRAIN]");
  });

  it("packs ADRs and KG triples incrementally instead of dropping all when combined list exceeds caps", async () => {
    const nowMs = Date.now();
    // 10 ADRs (~60 tokens each = ~600 tokens total, > 25% of 1000 = 250 tokens)
    const manyAdrs = Array.from(
      { length: 10 },
      (_, idx) =>
        `- **[adr_0${idx}] (tsimon.me) ADR-${idx} Rule**: ${"Detailed architectural specification text ".repeat(5)}`
    );
    // 15 KG triples (~25 tokens each = ~375 tokens total, + 250 ADRs > 45% of 1000 = 450 tokens)
    const manyTriples = Array.from({ length: 15 }, (_, idx) => ({
      subject: `service:edge-worker-node-${idx}`,
      predicate: "ROUTES_TO",
      object: `backend:durable-object-cluster-${idx}`
    }));

    const res = await fuseBrainAndKb({
      brainFts: [makeCandidate({ id: "c1", updatedAtMs: nowMs })],
      brainVec: [],
      kbFts: [],
      kbVec: [],
      activeDecisions: manyAdrs,
      extraTriples: manyTriples,
      tokenBudget: 1000
    });

    expect(res.totalTokens).toBeLessThanOrEqual(1000);
    // Must keep top ADRs instead of silently dropping all 10
    expect(res.contextBlock).toContain("ADR-0 Rule");
    expect(res.contextBlock).toContain("ADR-1 Rule");
    expect(res.contextBlock).not.toContain("ADR-9 Rule");
    // Must keep a subset of KG triples instead of dropping all 15
    expect(res.graphTriplesCount).toBeGreaterThan(0);
    expect(res.graphTriplesCount).toBeLessThan(15);
  });

  it("badges episodic_summary memories as [BRAIN] [DIGEST] and appends <recall_explanation> when explain=true", async () => {
    const nowMs = Date.now();
    const digestCand = makeCandidate({
      id: "digest-2026-11-20",
      memoryType: "episodic_summary",
      title: "[global] Daily Consolidated Episodic Digest 2026-11-20",
      content: "Summary citing [episodic:368] and [episodic:369].",
      importance: 0.72,
      confidence: 0.7,
      updatedAtMs: nowMs
    });
    const factCand = makeCandidate({
      id: "fact-1",
      memoryType: "semantic",
      title: "[homelab] Authoritative Fact",
      content: "Direct operator fact.",
      importance: 0.9,
      confidence: 1.0,
      updatedAtMs: nowMs
    });

    const res = await fuseBrainAndKb({
      brainFts: [factCand, digestCand],
      brainVec: [factCand],
      kbFts: [],
      kbVec: [],
      tokenBudget: 1200,
      halfLifeDays: 45,
      explain: true
    });

    expect(res.totalTokens).toBeLessThanOrEqual(1200);
    expect(res.contextBlock).toContain("[BRAIN] [DIGEST]");
    expect(res.contextBlock).toContain("<recall_explanation");
    expect(res.contextBlock).toContain("brain_fts=#1, brain_vec=#1");
    expect(res.contextBlock).toContain("hl=45d");
    expect(res.candidates[0].explanation?.channels).toEqual({ brain_fts: 1, brain_vec: 1 });
    expect(res.candidates[0].explanation?.modifiers.halfLifeDays).toBe(45);
    expect(res.candidates[0].explanation?.packedMode).toBe("full");
  });

  it("prevents near-zero-rerank cross-origin KB noise (< 0.15) from hijacking slot #2 while keeping relevant KB leaders", async () => {
    const nowMs = Date.now();
    const brain1 = makeCandidate({ id: "b1", title: "Primary Brain Answer", updatedAtMs: nowMs });
    const brain2 = makeCandidate({ id: "b2", title: "Secondary Brain Answer", updatedAtMs: nowMs });
    const noisyKb = makeCandidate({
      id: "Docs/Unrelated.md",
      source: "kb_vec",
      origin: "kb.tsimon.me",
      title: "Unrelated Archive Doc",
      uri: "https://kb.tsimon.me/doc/Unrelated.md",
      updatedAtMs: nowMs
    });

    // Case 1: KB candidate scores 0.004 (noise) -> must NOT jump ahead of Brain #2 (0.85)
    const noisyEnv = {
      AI: {
        async run() {
          return {
            response: [
              { id: 0, score: 0.95 }, // b1
              { id: 1, score: 0.85 }, // b2
              { id: 2, score: 0.004 } // noisyKb
            ]
          };
        }
      }
    } as unknown as Env;

    const rNoisy = await fuseBrainAndKb({
      env: noisyEnv,
      query: "brain only question",
      brainFts: [brain1, brain2],
      brainVec: [brain1, brain2],
      kbFts: [],
      kbVec: [noisyKb],
      tokenBudget: 1500
    });
    expect(rNoisy.candidates[0].id).toBe("brain:b1");
    expect(rNoisy.candidates[1].id).toBe("brain:b2");

    // Case 2: KB candidate scores 0.82 (genuinely relevant) -> promoted into top 2
    const relevantEnv = {
      AI: {
        async run() {
          return {
            response: [
              { id: 0, score: 0.95 }, // b1
              { id: 1, score: 0.55 }, // b2
              { id: 2, score: 0.82 } // relevant Kb
            ]
          };
        }
      }
    } as unknown as Env;

    const rRelevant = await fuseBrainAndKb({
      env: relevantEnv,
      query: "federated archive question",
      brainFts: [brain1, brain2],
      brainVec: [brain1, brain2],
      kbFts: [],
      kbVec: [noisyKb],
      tokenBudget: 1500
    });
    expect(rRelevant.candidates[0].id).toBe("brain:b1");
    expect(rRelevant.candidates[1].id).toBe("kb:Docs/Unrelated.md");
  });
});
