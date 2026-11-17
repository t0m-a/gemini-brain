/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\index.ts
 * Purpose: Stateless Streamable HTTP MCP v2 Server routing to BrainMemoryDO
 *          with 4-Way Federated Recall across BrainMemoryDO + kb.tsimon.me (D1 + Vectorize).
 */

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { BrainMemoryDO, type Env } from "./memory-do";
import {
  KbFederationService,
  ingestKbArchiveBatch,
  type KbArchiveIngestItem
} from "./federation";
import { renderDashboardHtml } from "./dashboard";

export { BrainMemoryDO, KbFederationService };

function createBrainMcpServer(env: Env) {
  const server = new McpServer({
    name: "gemini-brain-mcp",
    version: "1.4.0"
  });

  // Always route to the singleton Durable Object instance
  const getBrainStub = () => {
    const id = env.BRAIN_DO.idFromName("thomas-simon-primary-brain");
    return env.BRAIN_DO.get(id);
  };

  // Tool 1 (Alphabetical Order #1): get_overnight_diff
  server.registerTool(
    "get_overnight_diff",
    {
      description:
        "Retrieve overnight mutations, before/after diffs of modified facts, nocturnal 03:00 AM consolidation digests, and newly logged ADRs from the last N hours to hydrate your first morning coding session in Gemini, VS Code, or Antigravity.",
      inputSchema: z.object({
        hours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe("Lookback window in hours (default: 12)"),
        clientId: z
          .string()
          .optional()
          .describe("Optional filter by clientId (e.g., 'antigravity-win11-1', 'gemini-cli', 'gemini-web-architect')"),
        namespace: z
          .string()
          .optional()
          .describe("Optional filter by namespace ('global', 'tsimon.me', 'minkalab.net', 'homelab')"),
        operation: z
          .enum(["ALL", "INSERT", "UPDATE", "DELETE", "CONSOLIDATE", "ROLLBACK"])
          .optional()
          .describe("Optional filter by mutation operation type (default: 'ALL')"),
        format: z
          .enum(["markdown", "json"])
          .optional()
          .describe("Output format: 'markdown' for LLM session hydration (default) or 'json' for full before/after diffs")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.getOvernightDiff({
        hours: args.hours ?? 12,
        clientId: args.clientId,
        namespace: args.namespace,
        operation: args.operation ?? "ALL"
      });
      return {
        content: [
          {
            type: "text",
            text:
              args.format === "json"
                ? JSON.stringify(result, null, 2)
                : result.hydrationMarkdown
          }
        ]
      };
    }
  );

  // Tool 2 (Alphabetical Order #2): hybrid_recall
  server.registerTool(
    "hybrid_recall",
    {
      description:
        "Retrieve token-budgeted context using 4-way federated Reciprocal Rank Fusion across BrainMemoryDO (SQLite FTS5 BM25 + Vectorize bge-m3 1024-dim + 1-hop Knowledge Graph) and kb.tsimon.me (D1 archive-knowledge-db FTS5 + Vectorize archive-kb-index 768-dim).",
      inputSchema: z.object({
        query: z.string().describe("Search query or technical topic to recall"),
        namespace: z
          .string()
          .optional()
          .describe("Project scope (e.g., 'global', 'tsimon.me', 'minkalab.net', 'homelab')"),
        tokenBudget: z
          .number()
          .int()
          .min(200)
          .max(8000)
          .optional()
          .describe("Max tokens to return (default: 1500)"),
        halfLifeDays: z
          .number()
          .min(1)
          .max(365)
          .optional()
          .describe("Temporal decay half-life in days (default: 30)")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.hybridRecall(args);
      return {
        content: [{ type: "text", text: result.compiledMarkdown }]
      };
    }
  );

  // Tool 3 (Alphabetical Order #3): log_decision
  server.registerTool(
    "log_decision",
    {
      description:
        "Record an Architecture Decision Record (ADR) in SQLite and optionally deprecate a superseded decision.",
      inputSchema: z.object({
        title: z.string().describe("Short title of the architectural decision"),
        decision: z.string().describe("Exact specification or rule decided"),
        rationale: z.string().describe("Engineering justification and trade-offs"),
        namespace: z.string().optional().describe("Target project namespace"),
        supersedesDecisionId: z
          .string()
          .optional()
          .describe("ID of an older ADR this decision replaces")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.logDecision(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // Tool 4 (Alphabetical Order #4): log_episodic_event
  server.registerTool(
    "log_episodic_event",
    {
      description:
        "Append a raw episodic session event (tool call, observation, checkpoint, or error resolution) to SQLite for nocturnal 03:00 AM consolidation.",
      inputSchema: z.object({
        sessionId: z.string().describe("Active session identifier"),
        clientId: z
          .string()
          .describe("Client identifier (e.g., 'antigravity-win11-1', 'gemini-cli', 'gemini-web-architect')"),
        eventType: z
          .enum(["tool_call", "observation", "checkpoint", "error_resolution"])
          .describe("Type of episodic event"),
        payload: z.string().describe("Raw event payload or observation details")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.logEpisodicEvent(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // Tool 5 (Alphabetical Order #5): remember_fact
  server.registerTool(
    "remember_fact",
    {
      description:
        "Store a semantic or procedural memory in Durable Object SQLite, index its 1024-dim vector in Vectorize, and link optional knowledge graph triples.",
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe("Optional deterministic memory ID for idempotent upserts"),
        title: z.string().describe("Concise title of the memory chunk"),
        content: z.string().describe("Full Markdown or code block to store"),
        summary: z
          .string()
          .optional()
          .describe("1-2 sentence compressed summary for tight token budgets"),
        namespace: z
          .string()
          .optional()
          .describe("Namespace ('global', 'tsimon.me', 'minkalab.net', 'homelab')"),
        memoryType: z.enum(["semantic", "procedural", "episodic_summary"]).optional(),
        sourceUri: z
          .string()
          .optional()
          .describe("Originating file path, git commit, or URL"),
        clientId: z
          .string()
          .optional()
          .describe("Client identifier for mutation audit tracking (e.g., 'antigravity-win11-1', 'gemini-cli', 'gemini-web-architect')"),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Salience weight from 0.0 to 1.0"),
        createdAt: z
          .number()
          .int()
          .optional()
          .describe("Optional original Unix epoch timestamp in seconds for historical records"),
        triples: z
          .array(
            z.object({
              subjectId: z.string(),
              subjectName: z.string(),
              subjectType: z.string().optional(),
              relation: z.string(),
              objectId: z.string(),
              objectName: z.string(),
              objectType: z.string().optional()
            })
          )
          .optional()
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.rememberFact(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // Tool 6 (Alphabetical Order #6): resolve_conflict
  server.registerTool(
    "resolve_conflict",
    {
      description:
        "Manage Active Memory Governance & Semantic Contradiction Triage: resolve a flagged memory conflict ('keep', 'supersede', or 'merge'), list pending conflicts ('list'), or trigger an immediate contradiction audit ('audit').",
      inputSchema: z.object({
        action: z
          .enum(["keep", "supersede", "merge", "list", "audit"])
          .describe("Triage decision ('keep', 'supersede', 'merge') or query action ('list', 'audit')"),
        conflictId: z
          .number()
          .int()
          .optional()
          .describe("Conflict ID from memory_conflicts table (required when action is 'keep', 'supersede', or 'merge')"),
        mergedContent: z
          .string()
          .optional()
          .describe("Optional synthesized Markdown content when action is 'merge'"),
        namespace: z
          .string()
          .optional()
          .describe("Optional namespace filter when listing or auditing conflicts"),
        clientId: z
          .string()
          .optional()
          .describe("Client identifier recording the resolution (default: 'mcp-governance-triage')")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      if (args.action === "list") {
        const listRes = await stub.getMemoryConflicts({
          status: "pending",
          namespace: args.namespace
        });
        return {
          content: [{ type: "text", text: JSON.stringify(listRes, null, 2) }]
        };
      }
      if (args.action === "audit") {
        const auditRes = await stub.auditContradictionsNow({
          namespace: args.namespace,
          hours: 24,
          limit: 5
        });
        return {
          content: [{ type: "text", text: JSON.stringify(auditRes, null, 2) }]
        };
      }
      if (!args.conflictId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: "conflictId is required for keep / supersede / merge" },
                null,
                2
              )
            }
          ]
        };
      }
      const res = await stub.resolveMemoryConflict({
        conflictId: args.conflictId,
        action: args.action,
        mergedContent: args.mergedContent,
        clientId: args.clientId || "mcp-governance-triage"
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    }
  );

  // Resource 1: brain://decisions/active
  server.registerResource(
    "active-decisions",
    "brain://decisions/active",
    {
      title: "Active Architecture Decision Records (ADRs)",
      description:
        "Active ADRs governing all namespaces (global, tsimon.me, minkalab.net, homelab).",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const stub = getBrainStub();
      const markdown = await stub.getActiveDecisions("all");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: markdown
          }
        ]
      };
    }
  );

  // Resource 2: brain://telemetry/status
  server.registerResource(
    "telemetry-status",
    "brain://telemetry/status",
    {
      title: "Brain Telemetry & Consolidation Status",
      description:
        "Live counts and per-namespace breakdown of active memories, ADRs, knowledge graph nodes/edges, unconsolidated episodic logs, and next nocturnal consolidation alarm.",
      mimeType: "application/json"
    },
    async (uri) => {
      const stub = getBrainStub();
      const stats = await stub.getNamespaceStats("all");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2)
          }
        ]
      };
    }
  );

  // Resource 3: brain://audit/overnight
  server.registerResource(
    "overnight-diff",
    "brain://audit/overnight",
    {
      title: "Overnight Brain Diff & Morning Hydration Briefing",
      description:
        "Recent memory mutations, before/after state summary, ADRs, and 03:00 AM nocturnal consolidation digests from the last 12 hours.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const stub = getBrainStub();
      const diff = await stub.getOvernightDiff({ hours: 12 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: diff.hydrationMarkdown
          }
        ]
      };
    }
  );

  // Prompt 1: checkpoint-session
  server.registerPrompt(
    "checkpoint-session",
    {
      title: "Checkpoint Coding Session",
      description:
        "Summarize the current coding session and persist architectural decisions and episodic events into the Knowledge Brain.",
      argsSchema: z.object({
        project: z
          .string()
          .describe("Target project or namespace slug (e.g., 'tsimon.me', 'homelab')"),
        summary: z
          .string()
          .describe("Summary of work completed, debugging outcomes, and architectural decisions")
      })
    },
    ({ project, summary }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Checkpoint the current coding session for project "${project}".\n\n` +
              `Session Summary:\n${summary}\n\n` +
              `Please execute the following context engineering actions:\n` +
              `1. Invoke \`log_episodic_event\` with \`eventType: "checkpoint"\` to record this session summary for the nocturnal 03:00 AM consolidation cycle.\n` +
              `2. Invoke \`remember_fact\` (and \`log_decision\` where applicable) for all architectural decisions and permanent technical facts established during this coding session under namespace "${project}".`
          }
        }
      ]
    })
  );

  // Prompt 2: hydrate-morning-session
  server.registerPrompt(
    "hydrate-morning-session",
    {
      title: "Hydrate Morning Coding Session with Overnight Changes",
      description:
        "Pull the last 12-24 hours of memory mutations, ADRs, and 03:00 AM consolidation digests to ground your first morning session.",
      argsSchema: z.object({
        hours: z
          .string()
          .optional()
          .describe("Lookback window in hours (default: '12')"),
        namespace: z
          .string()
          .optional()
          .describe("Optional project namespace to focus on (e.g., 'homelab', 'tsimon.me')")
      })
    },
    ({ hours, namespace }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Hydrate this morning's coding session with recent state changes from the Knowledge Brain.\n\n` +
              `1. Invoke \`get_overnight_diff\` with \`hours: ${Number(hours) || 12}\`${namespace ? ` and \`namespace: "${namespace}"\`` : ""}.\n` +
              `2. Summarize the key overnight mutations, new ADRs, and any nocturnal consolidation digests.\n` +
              `3. If any pending semantic contradictions are listed under \`Pending Semantic Contradictions\`, present each conflict clearly and ask me for a 15-second \`keep\` / \`supersede\` / \`merge\` decision using \`resolve_conflict\`.`
          }
        }
      ]
    })
  );

  return server;
}

function normalizeBearerToken(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^MCP_BEARER_TOKEN\s*=\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

function toBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return decodeURIComponent(escape(atob(b64 + pad)));
}

function base64UrlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const raw = atob(b64 + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(payloadB64: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return uint8ArrayToBase64Url(new Uint8Array(sigBuf));
}

async function createSignedToken(
  prefix: string,
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, secret);
  return `${prefix}.${payloadB64}.${sig}`;
}

async function verifySignedToken<T extends { exp?: number }>(
  token: string,
  expectedPrefix: string,
  secret: string
): Promise<T | null> {
  if (!token || !secret || !token.startsWith(`${expectedPrefix}.`)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payloadB64, sig] = parts;
  const expectedSig = await hmacSign(payloadB64, secret);
  if (sig !== expectedSig) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(payloadB64)) as T;
    const nowSec = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < nowSec) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function verifyCloudflareOidcJwt(
  token: string,
  cfOidcBase: string,
  expectedClientId: string
): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(fromBase64Url(parts[0])) as { kid?: string; alg?: string };
    const payload = JSON.parse(fromBase64Url(parts[1])) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      client_id?: string;
    };

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return false;
    if (payload.iss && payload.iss !== cfOidcBase) return false;

    const audMatch =
      !payload.aud ||
      (Array.isArray(payload.aud)
        ? payload.aud.includes(expectedClientId)
        : payload.aud === expectedClientId) ||
      payload.client_id === expectedClientId;
    if (!audMatch) return false;

    const jwksRes = await fetch(`${cfOidcBase}/jwks`);
    if (!jwksRes.ok) return false;
    const jwks = (await jwksRes.json()) as {
      keys?: Array<JsonWebKey & { kid?: string; alg?: string }>;
    };
    const keys = jwks.keys || [];
    const matchingKey = header.kid
      ? keys.find((k) => k.kid === header.kid)
      : keys[0];
    if (!matchingKey) return false;

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      matchingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToUint8Array(parts[2]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data);
  } catch {
    return false;
  }
}

async function verifyCloudflareOidcToken(
  token: string,
  cfOidcBase: string,
  expectedClientId: string
): Promise<boolean> {
  if (!token) return false;

  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cacheKey = new Request(`https://auth-cache.internal/cf-oidc/${tokenHash}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return true;

  // 1. Try local cryptographic RS256 verification against Cloudflare Access JWKS
  const jwtValid = await verifyCloudflareOidcJwt(token, cfOidcBase, expectedClientId);
  if (jwtValid) {
    await cache.put(
      cacheKey,
      new Response("ok", { headers: { "Cache-Control": "max-age=300" } })
    );
    return true;
  }

  // 2. Fallback: Verify via Cloudflare OIDC userinfo endpoint
  try {
    const res = await fetch(`${cfOidcBase}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      await cache.put(
        cacheKey,
        new Response("ok", { headers: { "Cache-Control": "max-age=300" } })
      );
      return true;
    }
  } catch {
    // Ignore network errors and fail closed
  }

  return false;
}

const BRAIN_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b1120"/><circle cx="32" cy="32" r="18" fill="none" stroke="#06b6d4" stroke-width="4"/><circle cx="32" cy="32" r="7" fill="#10b981"/></svg>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const brainOrigin = `https://brain.${env.PRIMARY_DOMAIN || "tsimon.me"}`;
    const oauthClientId =
      env.OAUTH_CLIENT_ID ||
      "9993bd9cb3166c06c0238a160c6e19c516b7e13a83feb285ae00878b74740662";
    const oauthTeamDomain = (
      env.OAUTH_TEAM_DOMAIN || "https://wandering-grass-64c7.cloudflareaccess.com"
    ).replace(/\/+$/, "");
    const cfOidcBase = `${oauthTeamDomain}/cdn-cgi/access/sso/oidc/${oauthClientId}`;

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, X-Brain-Noc-Action, X-Brain-Token",
      "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. Browser static asset probes (prevent 401 responses from tripping Cloudflare WAF brute-force rules)
    if (
      request.method === "GET" &&
      (url.pathname === "/favicon.ico" ||
        url.pathname === "/favicon.svg" ||
        url.pathname === "/apple-touch-icon.png")
    ) {
      return new Response(BRAIN_FAVICON_SVG, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 1b. Public OAuth 2.0 / 2.1 Discovery & Proxy Endpoints (RFC 9728 + RFC 8414 + OIDC)
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/mcp/.well-known/oauth-protected-resource"
    ) {
      return Response.json(
        {
          resource: `${brainOrigin}/mcp`,
          authorization_servers: [brainOrigin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["openid", "email", "profile", "groups"]
        },
        { status: 200, headers: corsHeaders }
      );
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
      url.pathname === "/mcp/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/.well-known/openid-configuration/mcp" ||
      url.pathname === "/mcp/.well-known/openid-configuration"
    ) {
      return Response.json(
        {
          issuer: brainOrigin,
          authorization_endpoint: `${brainOrigin}/authorize`,
          token_endpoint: `${brainOrigin}/token`,
          userinfo_endpoint: `${brainOrigin}/userinfo`,
          jwks_uri: `${brainOrigin}/.well-known/jwks.json`,
          registration_endpoint: `${brainOrigin}/register`,
          scopes_supported: ["openid", "email", "profile", "groups"],
          response_types_supported: ["code"],
          response_modes_supported: ["query", "fragment", "form_post"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: [
            "client_secret_post",
            "client_secret_basic",
            "none"
          ],
          code_challenge_methods_supported: ["S256", "plain"],
          id_token_signing_alg_values_supported: ["RS256"],
          subject_types_supported: ["public"]
        },
        { status: 200, headers: corsHeaders }
      );
    }

    if (
      url.pathname === "/.well-known/jwks.json" ||
      url.pathname === "/mcp/jwks.json"
    ) {
      const jwksRes = await fetch(`${cfOidcBase}/jwks`);
      const jwksBody = await jwksRes.text();
      return new Response(jwksBody, {
        status: jwksRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/register" || url.pathname === "/mcp/register")
    ) {
      const regBody = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json(
        {
          client_id: oauthClientId,
          client_name: regBody.client_name || "mcp-oauth-client",
          redirect_uris: regBody.redirect_uris || [`${brainOrigin}/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post"
        },
        { status: 201, headers: corsHeaders }
      );
    }

    const expectedToken = normalizeBearerToken(env.MCP_BEARER_TOKEN);
    const signingSecret = expectedToken || oauthClientId;

    if (
      request.method === "GET" &&
      (url.pathname === "/authorize" || url.pathname === "/mcp/authorize")
    ) {
      const origRedirectUri = url.searchParams.get("redirect_uri") || "";
      const origState = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
      const callbackUri = `${brainOrigin}/callback`;
      const nowSec = Math.floor(Date.now() / 1000);

      const signedState = await createSignedToken(
        "bstate",
        {
          r: origRedirectUri || callbackUri,
          s: origState,
          cc: codeChallenge,
          ccm: codeChallengeMethod,
          exp: nowSec + 900
        },
        signingSecret
      );

      const targetAuthUrl = new URL(`${cfOidcBase}/authorization`);
      targetAuthUrl.searchParams.set("response_type", "code");
      targetAuthUrl.searchParams.set("client_id", oauthClientId);
      targetAuthUrl.searchParams.set("redirect_uri", callbackUri);
      targetAuthUrl.searchParams.set("scope", "openid email profile");
      targetAuthUrl.searchParams.set("state", signedState);

      return Response.redirect(targetAuthUrl.toString(), 302);
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/callback" || url.pathname === "/mcp/callback")
    ) {
      const rawState = url.searchParams.get("state") || "";
      const cfCode = url.searchParams.get("code") || "";
      const cfError = url.searchParams.get("error") || "";
      const nowSec = Math.floor(Date.now() / 1000);

      const decoded = await verifySignedToken<{
        r?: string;
        s?: string;
        cc?: string;
        ccm?: string;
        exp?: number;
      }>(rawState, "bstate", signingSecret);

      if (decoded?.r) {
        const clientCallback = new URL(decoded.r);
        if (cfError || !cfCode) {
          clientCallback.searchParams.set("error", cfError || "access_denied");
          const errDesc = url.searchParams.get("error_description");
          if (errDesc) clientCallback.searchParams.set("error_description", errDesc);
        } else {
          // Mint HMAC-signed authorization code proving Cloudflare Zero Trust authentication succeeded
          const signedCode = await createSignedToken(
            "bcode",
            {
              cf: cfCode,
              cc: decoded.cc || "",
              ccm: decoded.ccm || "S256",
              exp: nowSec + 600
            },
            signingSecret
          );
          clientCallback.searchParams.set("code", signedCode);
        }
        if (decoded.s) {
          clientCallback.searchParams.set("state", decoded.s);
        }
        return Response.redirect(clientCallback.toString(), 302);
      }

      return Response.json(
        {
          ok: Boolean(cfCode && !cfError),
          error: cfError || undefined,
          error_description: url.searchParams.get("error_description") || undefined
        },
        { status: cfError ? 400 : 200, headers: corsHeaders }
      );
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/token" || url.pathname === "/mcp/token")
    ) {
      const contentType = request.headers.get("Content-Type") || "";
      const rawBody = await request.text();
      const params = new URLSearchParams(
        contentType.includes("application/json")
          ? (JSON.parse(rawBody || "{}") as Record<string, string>)
          : rawBody
      );

      const grantType = params.get("grant_type") || "authorization_code";
      const codeParam = params.get("code") || "";
      const refreshParam = params.get("refresh_token") || "";
      const codeVerifier = params.get("code_verifier") || "";
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Exchange HMAC-signed authorization code ('bcode.*') minted after Cloudflare Zero Trust login
      if (grantType === "authorization_code" && codeParam.startsWith("bcode.")) {
        const decodedCode = await verifySignedToken<{
          cf: string;
          cc?: string;
          ccm?: string;
          exp?: number;
        }>(codeParam, "bcode", signingSecret);

        if (!decodedCode) {
          return Response.json(
            { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        // Verify PKCE code_verifier if a code_challenge was provided during /authorize and verifier is present
        if (decodedCode.cc && codeVerifier) {
          if (decodedCode.ccm === "S256") {
            const hashBuf = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(codeVerifier)
            );
            const computedChallenge = uint8ArrayToBase64Url(new Uint8Array(hashBuf));
            if (computedChallenge !== decodedCode.cc) {
              return Response.json(
                { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" },
                { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
              );
            }
          } else if (codeVerifier !== decodedCode.cc) {
            return Response.json(
              { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" },
              { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
            );
          }
        }

        const accessToken = await createSignedToken(
          "bat",
          {
            sub: "thomas-simon-primary-brain",
            client_id: oauthClientId,
            iat: nowSec,
            exp: nowSec + 2592000 // 30 days
          },
          signingSecret
        );
        const refreshToken = await createSignedToken(
          "brt",
          {
            sub: "thomas-simon-primary-brain",
            client_id: oauthClientId,
            iat: nowSec,
            exp: nowSec + 31536000 // 365 days
          },
          signingSecret
        );

        return Response.json(
          {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 2592000,
            refresh_token: refreshToken,
            scope: "openid email profile"
          },
          { status: 200, headers: { "Cache-Control": "no-store", ...corsHeaders } }
        );
      }

      // 2. Refresh token rotation ('brt.*')
      if (grantType === "refresh_token" && refreshParam.startsWith("brt.")) {
        const decodedRefresh = await verifySignedToken<{
          sub: string;
          client_id: string;
          exp?: number;
        }>(refreshParam, "brt", signingSecret);

        if (!decodedRefresh) {
          return Response.json(
            { error: "invalid_grant", error_description: "Invalid or expired refresh token" },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const accessToken = await createSignedToken(
          "bat",
          {
            sub: decodedRefresh.sub,
            client_id: oauthClientId,
            iat: nowSec,
            exp: nowSec + 2592000
          },
          signingSecret
        );
        const newRefreshToken = await createSignedToken(
          "brt",
          {
            sub: decodedRefresh.sub,
            client_id: oauthClientId,
            iat: nowSec,
            exp: nowSec + 31536000
          },
          signingSecret
        );

        return Response.json(
          {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 2592000,
            refresh_token: newRefreshToken,
            scope: "openid email profile"
          },
          { status: 200, headers: { "Cache-Control": "no-store", ...corsHeaders } }
        );
      }

      // 3. Fallback: Direct upstream Cloudflare Access OIDC token exchange (with redirect: "manual")
      const forwardHeaders: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      };
      const authHeader = request.headers.get("Authorization");
      if (authHeader) {
        forwardHeaders["Authorization"] = authHeader;
      } else if (!params.get("client_id")) {
        params.set("client_id", oauthClientId);
      }

      const tokenRes = await fetch(`${cfOidcBase}/token`, {
        method: "POST",
        headers: forwardHeaders,
        body: params.toString(),
        redirect: "manual"
      });

      if (tokenRes.status >= 300 && tokenRes.status < 400) {
        const loc = tokenRes.headers.get("Location") || "";
        const locUrl = new URL(loc, brainOrigin);
        return Response.json(
          {
            error: locUrl.searchParams.get("error") || "invalid_grant",
            error_description:
              locUrl.searchParams.get("error_description") ||
              "Upstream Cloudflare Access token exchange failed"
          },
          { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
        );
      }

      const tokenBody = await tokenRes.text();
      return new Response(tokenBody, {
        status: tokenRes.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...corsHeaders
        }
      });
    }

    if (url.pathname === "/userinfo" || url.pathname === "/mcp/userinfo") {
      const provided = normalizeBearerToken(request.headers.get("Authorization"));
      const signedTokenValid = await verifySignedToken(provided, "bat", signingSecret);
      if (signedTokenValid || (expectedToken && provided === expectedToken)) {
        return Response.json(
          {
            sub: "thomas-simon-primary-brain",
            name: "Thomas Mathieu Simon",
            email: "thomas@tsimon.me",
            email_verified: true
          },
          { status: 200, headers: corsHeaders }
        );
      }
      const userRes = await fetch(`${cfOidcBase}/userinfo`, {
        method: request.method,
        headers: {
          Authorization: request.headers.get("Authorization") || "",
          Accept: "application/json"
        }
      });
      const userBody = await userRes.text();
      return new Response(userBody, {
        status: userRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // SEP-2127 Static Discovery Card for zero-connection MCP capability inspection
    if (
      url.pathname === "/server-card" ||
      url.pathname === "/.well-known/ai-catalog.json" ||
      url.pathname === "/.well-known/mcp/server-card.json"
    ) {
      return Response.json(
        {
          name: "gemini-brain-mcp",
          version: "1.5.0",
          endpoint: `${brainOrigin}/mcp`,
          dashboard: `${brainOrigin}/mcp?ui=1`,
          oauth_metadata: `${brainOrigin}/.well-known/oauth-authorization-server`,
          federated_sources: [
            "brain.tsimon.me (BrainMemoryDO + gemini-brain-bge-m3 1024-dim + bge-reranker-base)",
            "kb.tsimon.me (D1 archive-knowledge-db + archive-kb-index 768-dim)"
          ],
          tools: [
            "get_overnight_diff",
            "hybrid_recall",
            "log_decision",
            "log_episodic_event",
            "remember_fact",
            "resolve_conflict"
          ]
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // 2. Public Browser Session Auth UI Shell (Option A: Zero secrets embedded in HTML)
    // Served on /dashboard, /ui, /, and GET /mcp (when visited in a web browser via Accept: text/html)
    // so that path-scoped Cloudflare WAF rules on /mcp also allow loading the UI shell.
    const acceptHeader = (request.headers.get("Accept") || "").toLowerCase();
    const secFetchDest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
    const secFetchMode = (request.headers.get("Sec-Fetch-Mode") || "").toLowerCase();
    const isBrowserHtmlGet =
      request.method === "GET" &&
      (url.pathname === "/dashboard" ||
        url.pathname === "/ui" ||
        url.pathname === "/" ||
        (url.pathname === "/mcp" &&
          (acceptHeader.includes("text/html") ||
            secFetchDest === "document" ||
            secFetchMode === "navigate" ||
            url.searchParams.has("ui") ||
            url.searchParams.has("reset"))));

    if (isBrowserHtmlGet) {
      return new Response(renderDashboardHtml(env.PRIMARY_DOMAIN || "tsimon.me"), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          ...corsHeaders
        }
      });
    }

    const getBrainStub = () => {
      const id = env.BRAIN_DO.idFromName("thomas-simon-primary-brain");
      return env.BRAIN_DO.get(id);
    };

    // 3. Browser Cognitive NOC Action Multiplexer (POST /mcp?noc=1 or POST /dashboard)
    // Uses POST /mcp (the WAF-whitelisted MCP endpoint) and returns HTTP 200 on auth mismatch
    // so Cloudflare WAF / Rate-Limiting never locks out the user's browser IP with HTTP 403.
    const nocActionHeader = request.headers.get("X-Brain-Noc-Action");
    if (
      request.method === "POST" &&
      (nocActionHeader ||
        url.searchParams.has("noc") ||
        url.pathname === "/dashboard" ||
        url.pathname === "/ui")
    ) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const action = String(nocActionHeader || body.nocAction || url.searchParams.get("noc") || "dashboard");
      const providedToken = normalizeBearerToken(
        request.headers.get("Authorization") ||
          request.headers.get("X-Brain-Token") ||
          (typeof body._token === "string" ? body._token : "")
      );

      if (expectedToken && providedToken !== expectedToken) {
        return Response.json(
          {
            ok: false,
            authError:
              "Invalid MCP_BEARER_TOKEN. Make sure you pasted the 64-character token value from .dev.vars."
          },
          { status: 200, headers: corsHeaders }
        );
      }

      const stub = getBrainStub();
      if (action === "dashboard") {
        const snapshot = await stub.getDashboardSnapshot({
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          memoryType: typeof body.memoryType === "string" ? body.memoryType : undefined,
          search: typeof body.search === "string" ? body.search : undefined,
          limit: typeof body.limit === "number" ? body.limit : 250
        });
        return Response.json({ ok: true, ...snapshot }, { status: 200, headers: corsHeaders });
      }

      if (action === "recall") {
        const query = String(body.query || "").trim();
        if (!query) {
          return Response.json({ ok: false, error: "Missing 'query'" }, { status: 200, headers: corsHeaders });
        }
        const recallRes = await stub.hybridRecall({
          query,
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          tokenBudget: typeof body.tokenBudget === "number" ? body.tokenBudget : 2000
        });
        return Response.json({ ok: true, ...recallRes }, { status: 200, headers: corsHeaders });
      }

      if (action === "consolidate") {
        const consRes = await stub.runConsolidationNow(
          typeof body.triggerSource === "string" ? body.triggerSource : "dashboard_noc"
        );
        return Response.json({ ok: true, ...consRes }, { status: 200, headers: corsHeaders });
      }

      if (action === "reindex") {
        const reidxRes = await stub.reindexMemories({
          rebuildFts: body.rebuildFts !== false,
          hours: typeof body.hours === "number" ? body.hours : 720,
          limit: typeof body.limit === "number" ? body.limit : 50
        });
        return Response.json({ ...reidxRes }, { status: 200, headers: corsHeaders });
      }

      if (action === "rollback") {
        const rbRes = await stub.rollbackMutation({
          mutationId: typeof body.mutationId === "number" ? body.mutationId : undefined,
          memoryId: typeof body.memoryId === "string" ? body.memoryId : undefined,
          clientId: typeof body.clientId === "string" ? body.clientId : "dashboard-noc-operator"
        });
        return Response.json(rbRes, { status: 200, headers: corsHeaders });
      }

      if (action === "conflicts") {
        const confRes = await stub.getMemoryConflicts({
          status:
            body.status === "pending" || body.status === "resolved" ? body.status : "all",
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          limit: typeof body.limit === "number" ? body.limit : 50
        });
        return Response.json({ ok: true, ...confRes }, { status: 200, headers: corsHeaders });
      }

      if (action === "audit_conflicts") {
        const auditRes = await stub.auditContradictionsNow({
          memoryId: typeof body.memoryId === "string" ? body.memoryId : undefined,
          hours: typeof body.hours === "number" ? body.hours : 24,
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          limit: typeof body.limit === "number" ? body.limit : 5
        });
        return Response.json(auditRes, { status: 200, headers: corsHeaders });
      }

      if (action === "resolve_conflict") {
        const resAction =
          body.action === "keep" || body.action === "supersede" || body.action === "merge"
            ? body.action
            : "supersede";
        const resolveRes = await stub.resolveMemoryConflict({
          conflictId: Number(body.conflictId),
          action: resAction,
          mergedContent: typeof body.mergedContent === "string" ? body.mergedContent : undefined,
          clientId:
            typeof body.clientId === "string" ? body.clientId : "dashboard-noc-operator"
        });
        return Response.json(resolveRes, { status: 200, headers: corsHeaders });
      }
    }

    // 4. Dual-Mode Auth Gate: Fast-Path PSK (gemini-cli / Antigravity) + Signed Brain OAuth + Cloudflare OIDC
    if (expectedToken) {
      const provided = normalizeBearerToken(
        request.headers.get("Authorization") || request.headers.get("X-Brain-Token")
      );
      const isPskValid = provided === expectedToken;
      const isSignedOAuthValid =
        !isPskValid &&
        Boolean(provided) &&
        Boolean(await verifySignedToken(provided, "bat", signingSecret));
      const isOidcValid =
        !isPskValid &&
        !isSignedOAuthValid &&
        Boolean(provided) &&
        (await verifyCloudflareOidcToken(provided, cfOidcBase, oauthClientId));

      if (!isPskValid && !isSignedOAuthValid && !isOidcValid) {
        return new Response(
          JSON.stringify({
            error: "Unauthorized",
            error_description: "Bearer token or OAuth 2.0 credentials required"
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${brainOrigin}/.well-known/oauth-protected-resource", as_uri="${brainOrigin}/.well-known/oauth-authorization-server"`,
              ...corsHeaders
            }
          }
        );
      }
    }

    // Authenticated Cognitive NOC Dashboard Snapshot & 4-Way Recall Routes
    if (url.pathname === "/audit/dashboard") {
      const params =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as Parameters<
              BrainMemoryDO["getDashboardSnapshot"]
            >[0])
          : {
              namespace: url.searchParams.get("namespace") ?? undefined,
              memoryType: url.searchParams.get("memoryType") ?? undefined,
              search: url.searchParams.get("search") ?? undefined,
              limit: url.searchParams.get("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined
            };
      const result = await getBrainStub().getDashboardSnapshot(params);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/audit/recall") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["hybridRecall"]
      >[0];
      if (!body.query || !body.query.trim()) {
        return Response.json({ error: "Missing required 'query' parameter" }, { status: 400 });
      }
      const result = await getBrainStub().hybridRecall(body);
      return Response.json(result);
    }

    // Authenticated Terminal Audit & Control Routes (/audit/*)
    if (url.pathname === "/audit/diff") {
      const params =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as Parameters<
              BrainMemoryDO["getOvernightDiff"]
            >[0])
          : {
              hours: url.searchParams.get("hours")
                ? Number(url.searchParams.get("hours"))
                : undefined,
              clientId: url.searchParams.get("clientId") ?? undefined,
              namespace: url.searchParams.get("namespace") ?? undefined,
              memoryId: url.searchParams.get("memoryId") ?? undefined,
              operation: (url.searchParams.get("operation") ?? undefined) as
                | "ALL"
                | "INSERT"
                | "UPDATE"
                | "DELETE"
                | "CONSOLIDATE"
                | "ROLLBACK"
                | undefined,
              limit: url.searchParams.get("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined
            };
      const result = await getBrainStub().getOvernightDiff(params);
      return Response.json(result);
    }

    if (url.pathname === "/audit/logs") {
      const params =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as Parameters<
              BrainMemoryDO["getConsolidationLogs"]
            >[0])
          : {
              hours: url.searchParams.get("hours")
                ? Number(url.searchParams.get("hours"))
                : undefined,
              clientId: url.searchParams.get("clientId") ?? undefined,
              pendingOnly: url.searchParams.get("pendingOnly") === "true",
              limit: url.searchParams.get("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined
            };
      const result = await getBrainStub().getConsolidationLogs(params);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/audit/rollback") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["rollbackMutation"]
      >[0];
      const result = await getBrainStub().rollbackMutation(body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (request.method === "POST" && url.pathname === "/audit/reindex") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["reindexMemories"]
      >[0];
      const result = await getBrainStub().reindexMemories(body);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/audit/consolidate") {
      const body = (await request.json().catch(() => ({}))) as { triggerSource?: string };
      const result = await getBrainStub().runConsolidationNow(
        body.triggerSource || "manual_cli"
      );
      return Response.json(result);
    }

    if (url.pathname === "/audit/conflicts") {
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          auditNow?: boolean;
          status?: "pending" | "resolved" | "all";
          namespace?: string;
          memoryId?: string;
          hours?: number;
          limit?: number;
        };
        if (body.auditNow) {
          const auditResult = await getBrainStub().auditContradictionsNow({
            memoryId: body.memoryId,
            hours: body.hours ?? 24,
            namespace: body.namespace,
            limit: body.limit ?? 5
          });
          return Response.json(auditResult);
        }
        const listResult = await getBrainStub().getMemoryConflicts({
          status: body.status ?? "all",
          namespace: body.namespace,
          limit: body.limit ?? 50
        });
        return Response.json({ ok: true, ...listResult });
      }
      const listResult = await getBrainStub().getMemoryConflicts({
        status: (url.searchParams.get("status") as "pending" | "resolved" | "all") || "all",
        namespace: url.searchParams.get("namespace") ?? undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50
      });
      return Response.json({ ok: true, ...listResult });
    }

    if (request.method === "POST" && url.pathname === "/audit/resolve-conflict") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["resolveMemoryConflict"]
      >[0];
      const result = await getBrainStub().resolveMemoryConflict(body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    // Authenticated High-Throughput Batch Ingestion Routes (Tier 1 Brain + Tier 2 KB Archive)
    if (request.method === "POST" && url.pathname === "/ingest/brain-batch") {
      const body = (await request.json()) as {
        items: Parameters<BrainMemoryDO["rememberFactsBatch"]>[0];
      };
      const result = await getBrainStub().rememberFactsBatch(body.items ?? []);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/ingest/kb-batch") {
      const body = (await request.json()) as { items: KbArchiveIngestItem[] };
      const result = await ingestKbArchiveBatch(env, body.items ?? []);
      return Response.json(result);
    }

    if (request.method === "DELETE" && url.pathname === "/mcp") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null
        },
        {
          status: 405,
          headers: { Allow: "POST, DELETE, OPTIONS", ...corsHeaders }
        }
      );
    }

    // Handle POST /mcp via direct stateless JSON-mode Streamable HTTP transport
    // (avoids 403 Origin blocks on gemini.google.com, 406 Accept errors, and hanging SSE keep-alive streams)
    const rawMcpBody = await request.text();
    let parsedMcpBody: unknown;
    try {
      parsedMcpBody = rawMcpBody ? JSON.parse(rawMcpBody) : undefined;
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
          id: null
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const normalizedHeaders = new Headers(request.headers);
    normalizedHeaders.set("Accept", "application/json, text/event-stream");
    normalizedHeaders.set("Content-Type", "application/json");
    normalizedHeaders.delete("Origin");
    normalizedHeaders.delete("mcp-protocol-version");

    const normalizedReq = new Request(request.url, {
      method: request.method,
      headers: normalizedHeaders
    });

    const server = createBrainMcpServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    let mcpResponse: Response;
    try {
      mcpResponse = await transport.handleRequest(normalizedReq, {
        parsedBody: parsedMcpBody
      });
    } finally {
      ctx.waitUntil(
        Promise.allSettled([transport.close(), server.close()])
      );
    }

    const respHeaders = new Headers(mcpResponse.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      respHeaders.set(k, v);
    }
    const sessionId =
      request.headers.get("Mcp-Session-Id") ||
      request.headers.get("mcp-session-id") ||
      "brain-stateless-session";
    respHeaders.set("Mcp-Session-Id", sessionId);

    // Log OAuth-authenticated MCP calls asynchronously for live observability
    const providedToken = normalizeBearerToken(
      request.headers.get("Authorization") || request.headers.get("X-Brain-Token")
    );
    if (providedToken && providedToken !== expectedToken) {
      const rpcMethod =
        typeof parsedMcpBody === "object" &&
        parsedMcpBody !== null &&
        "method" in parsedMcpBody
          ? String((parsedMcpBody as { method?: unknown }).method)
          : "batch";
      ctx.waitUntil(
        getBrainStub()
          .logEpisodicEvent({
            sessionId,
            clientId: "gemini-web-oauth",
            eventType: "tool_call",
            payload: JSON.stringify({
              rpcMethod,
              status: mcpResponse.status,
              ua: request.headers.get("User-Agent") || "",
              accept: request.headers.get("Accept") || "",
              origin: request.headers.get("Origin") || ""
            })
          })
          .catch(() => {})
      );
    }

    return new Response(mcpResponse.body, {
      status: mcpResponse.status,
      statusText: mcpResponse.statusText,
      headers: respHeaders
    });
  }
} satisfies ExportedHandler<Env>;
