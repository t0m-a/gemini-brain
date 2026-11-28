/**
 * In-memory Durable Object SQLite + Storage + Vectorize + Workers AI harness
 * backed by Node's built-in `node:sqlite` (`DatabaseSync`, with FTS5, json_each, and math EXP).
 */

import { DatabaseSync } from "node:sqlite";
import type { Env } from "../../src/memory-do";

class MockSqlCursor<T extends Record<string, unknown>> {
  private rows: T[];

  constructor(rows: T[]) {
    this.rows = rows;
  }

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length === 0) {
      throw new Error("Expected 1 row from SQLite query, got 0");
    }
    return this.rows[0];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

export class MockSqlStorage {
  public db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): MockSqlCursor<T> {
    const trimmed = query.trim();
    if (bindings.length === 0 && trimmed.includes(";") && trimmed.indexOf(";") < trimmed.length - 1) {
      this.db.exec(trimmed);
      return new MockSqlCursor<T>([]);
    }

    const stmt = this.db.prepare(trimmed);
    const normalizedBindings = bindings.map((v) =>
      v === undefined ? null : (v as string | number | bigint | Uint8Array | null)
    );

    const upper = trimmed.toUpperCase();
    const returnsRows =
      upper.startsWith("SELECT") ||
      upper.startsWith("WITH") ||
      upper.startsWith("PRAGMA") ||
      upper.includes("RETURNING ");

    if (returnsRows) {
      const rows = stmt.all(...normalizedBindings) as T[];
      // Normalize null-prototype objects from node:sqlite to plain objects
      return new MockSqlCursor<T>(rows.map((r) => ({ ...r })));
    }

    stmt.run(...normalizedBindings);
    return new MockSqlCursor<T>([]);
  }
}

export function createMockDurableObjectState() {
  const sql = new MockSqlStorage();
  let alarmMs: number | null = null;
  const initPromises: Promise<unknown>[] = [];

  const state = {
    sql,
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        sql.db.exec("BEGIN");
        try {
          const result = fn();
          sql.db.exec("COMMIT");
          return result;
        } catch (err) {
          sql.db.exec("ROLLBACK");
          throw err;
        }
      },
      async getAlarm(): Promise<number | null> {
        return alarmMs;
      },
      async setAlarm(ms: number | Date): Promise<void> {
        alarmMs = ms instanceof Date ? ms.getTime() : ms;
      }
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      initPromises.push(p);
      return p;
    },
    async waitUntilReady(): Promise<void> {
      await Promise.all(initPromises);
    }
  };

  return state;
}

export class MockVectorizeIndex {
  public vectors = new Map<string, VectorizeVector>();

  async upsert(records: VectorizeVector[]): Promise<{ count: number; ids: string[] }> {
    for (const r of records) {
      this.vectors.set(r.id, r);
    }
    return { count: records.length, ids: records.map((r) => r.id) };
  }

  async deleteByIds(ids: string[]): Promise<{ count: number; ids: string[] }> {
    for (const id of ids) {
      this.vectors.delete(id);
    }
    return { count: ids.length, ids };
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    const out: VectorizeVector[] = [];
    for (const id of ids) {
      const rec = this.vectors.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  async query(
    vector: number[],
    options?: { topK?: number; namespace?: string; returnMetadata?: string }
  ): Promise<{ matches: VectorizeMatch[]; count: number }> {
    const topK = options?.topK ?? 10;
    const ns = options?.namespace;
    const matches: VectorizeMatch[] = [];

    for (const rec of this.vectors.values()) {
      if (ns && rec.namespace && rec.namespace !== ns) continue;
      // Simple cosine similarity against stored values
      const vals = Array.from(rec.values as number[]);
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < Math.min(vector.length, vals.length); i++) {
        dot += vector[i] * vals[i];
        magA += vector[i] * vector[i];
        magB += vals[i] * vals[i];
      }
      const score = magA > 0 && magB > 0 ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0.5;
      matches.push({
        id: rec.id,
        score,
        namespace: rec.namespace,
        metadata: rec.metadata
      });
    }

    matches.sort((a, b) => b.score - a.score);
    const sliced = matches.slice(0, topK);
    return { matches: sliced, count: sliced.length };
  }
}

/**
 * Deterministic bag-of-characters embedding generator for isolated tests.
 */
function deterministicEmbed(text: string, dims = 8): number[] {
  const vec = new Array<number>(dims).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    vec[lower.charCodeAt(i) % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function createMockEnv(overrides: Partial<Env> = {}) {
  const vectorIndex = new MockVectorizeIndex();
  const kbVectorIndex = new MockVectorizeIndex();

  const mockAi = {
    async run(model: string, input: Record<string, unknown>) {
      if (model.includes("reranker")) {
        const contexts = (input.contexts as Array<{ text: string }>) || [];
        return {
          response: contexts.map((_, idx) => ({
            id: idx,
            score: Math.max(0.1, 0.95 - idx * 0.05)
          }))
        };
      }
      if (model.includes("llama")) {
        return { response: "[]" };
      }
      const texts = Array.isArray(input.text) ? (input.text as string[]) : [String(input.text || "")];
      return {
        data: texts.map((t) => deterministicEmbed(t, 8))
      };
    }
  };

  const env = {
    BRAIN_DO: {} as Env["BRAIN_DO"],
    VECTOR_INDEX: vectorIndex as unknown as VectorizeIndex,
    KB_DB: undefined as unknown as D1Database,
    KB_VECTORIZE: kbVectorIndex as unknown as VectorizeIndex,
    AI: mockAi as unknown as Ai,
    DEFAULT_NAMESPACE: "global",
    PRIMARY_DOMAIN: "tsimon.me",
    EMBEDDING_MODEL: "@cf/baai/bge-m3",
    KB_EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
    RERANKER_MODEL: "@cf/baai/bge-reranker-base",
    MCP_BEARER_TOKEN: "test-bearer-token-64-chars-minimum-entropy-for-unit-tests-000001",
    OAUTH_CLIENT_ID: "9993bd9cb3166c06c0238a160c6e19c516b7e13a83feb285ae00878b74740662",
    OAUTH_TEAM_DOMAIN: "https://wandering-grass-64c7.cloudflareaccess.com",
    ...overrides
  } as Env;

  return { env, vectorIndex, kbVectorIndex, mockAi };
}
