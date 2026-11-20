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
import { BRAIN_VERSION } from "./version";
import {
  createSignedToken,
  extractBasicAuthCredentials,
  isAllowedRedirectUri,
  normalizeBearerToken,
  timingSafeStringEqual,
  verifyCloudflareOidcJwt,
  verifyCloudflareOidcToken,
  verifyPkceChallenge,
  verifySignedToken
} from "./auth";

export { BrainMemoryDO, KbFederationService };

function createBrainMcpServer(env: Env) {
  const server = new McpServer({
    name: "gemini-brain-mcp",
    version: BRAIN_VERSION
  });

  // Always route to the singleton Durable Object instance
  const getBrainStub = () => {
    const id = env.BRAIN_DO.idFromName("thomas-simon-primary-brain");
    return env.BRAIN_DO.get(id);
  };

  // Tool 1 (Alphabetical Order #1): forget_memory
  server.registerTool(
    "forget_memory",
    {
      description:
        "Deliberately retire or permanently erase a stale, incorrect, or synthetic memory from SQLite, FTS5, Vectorize, and linked non-protected Knowledge Graph edges. 'soft_retire' is reversible via rollback; 'hard_delete' permanently erases the row and scrubs historical audit content.",
      inputSchema: z.object({
        memoryId: z.string().describe("Exact ID of the memory to retire or delete"),
        mode: z
          .enum(["soft_retire", "hard_delete"])
          .optional()
          .describe("'soft_retire' (default, reversible via rollback) or 'hard_delete' (permanent erasure + audit scrub)"),
        reason: z
          .string()
          .optional()
          .describe("Concise explanation recorded in the mutation audit trail"),
        retireLinkedEdges: z
          .boolean()
          .optional()
          .describe("Expire/remove non-protected KG edges backed solely by this memory (default: true)"),
        clientId: z
          .string()
          .optional()
          .describe("Client identifier recording the deletion (default: 'mcp-forget')")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.forgetMemory(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // Tool 2 (Alphabetical Order #2): get_overnight_diff
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
          .describe("Temporal decay half-life in days (default: 30)"),
        explain: z
          .boolean()
          .optional()
          .describe("Include per-candidate ranking decomposition (<recall_explanation>) with channel ranks, decay, confidence, and reranker boosts")
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

  // Tool 4 (Alphabetical Order #4): log_decision
  server.registerTool(
    "log_decision",
    {
      description:
        "Record an Architecture Decision Record (ADR) in SQLite with rationale, optional rejected alternatives, and revisit triggers; optionally deprecate a superseded decision.",
      inputSchema: z.object({
        title: z.string().describe("Short title of the architectural decision"),
        decision: z.string().describe("Exact specification or rule decided"),
        rationale: z.string().describe("Engineering justification and trade-offs"),
        namespace: z.string().optional().describe("Target project namespace"),
        rejectedOptions: z
          .array(z.string())
          .optional()
          .describe("Alternative options considered and why each was rejected"),
        revisitWhen: z
          .array(z.string())
          .optional()
          .describe("Explicit conditions or scale thresholds that should trigger revisiting this ADR"),
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

  // Tool 6 (Alphabetical Order #6): record_outcome
  server.registerTool(
    "record_outcome",
    {
      description:
        "Record a first-class task outcome (attempted task, observed result, status, failed_attempts, verifier, and cited memories) at the conclusion of substantive work. Only adjusts cited memory confidence conservatively when backed by an explicit verifier or operatorFeedback.",
      inputSchema: z.object({
        outcomeId: z
          .string()
          .optional()
          .describe("Optional deterministic outcome ID for idempotent updates"),
        sessionId: z.string().describe("Active conversation or session UUID"),
        namespace: z
          .string()
          .optional()
          .describe("Target namespace ('global', 'tsimon.me', 'minkalab.net', 'homelab', 'ai-research', 'career')"),
        taskType: z
          .string()
          .describe("Task category (e.g., 'bug_fix', 'architecture', 'deployment', 'audit', 'research', 'ops')"),
        query: z.string().describe("Concise description of the problem or task attempted"),
        status: z
          .enum(["success", "partial", "failure", "abandoned"])
          .describe("Verified outcome status"),
        resultSummary: z.string().describe("Observed empirical result and verification outcome"),
        failedAttempts: z
          .string()
          .optional()
          .describe("Explicit record of hypotheses, approaches, or commands that did NOT work"),
        citedMemoryIds: z
          .array(z.string())
          .optional()
          .describe("Optional Brain memory IDs that directly influenced the outcome"),
        verifier: z
          .string()
          .optional()
          .describe("Objective verifier (e.g., 'vitest', 'eval/run_eval.py', 'wrangler deploy', 'operator')"),
        evidenceUri: z
          .string()
          .optional()
          .describe("Optional commit SHA, PR URL, log URI, or artifact path"),
        operatorFeedback: z
          .union([z.literal(-1), z.literal(0), z.literal(1)])
          .optional()
          .describe("Optional explicit operator rating: -1 (harmful/stale), 0 (neutral), +1 (helpful)"),
        clientId: z
          .string()
          .optional()
          .describe("Client identifier (default: 'mcp-outcome')")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.recordOutcome(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // Tool 7 (Alphabetical Order #7): remember_fact
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
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Epistemic certainty from 0.0 to 1.0 (default: 1.0)"),
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

  // Tool 9 (Alphabetical Order #9): validate_memory
  server.registerTool(
    "validate_memory",
    {
      description:
        "Attach empirical verification evidence to an existing memory ('confirmed', 'weakened', or 'invalid'), updating epistemic confidence, freshness (on confirmation), and the immutable memory_validations audit log.",
      inputSchema: z.object({
        memoryId: z.string().describe("Exact ID of the memory to validate"),
        verdict: z
          .enum(["confirmed", "weakened", "invalid"])
          .describe("'confirmed' boosts confidence & refreshes decay; 'weakened' reduces confidence; 'invalid' drops confidence to 0.05"),
        evidenceUri: z
          .string()
          .optional()
          .describe("URI, commit hash, command output reference, or doc link supporting the verdict"),
        notes: z
          .string()
          .optional()
          .describe("Concise explanation of what was verified or invalidated"),
        observedAt: z
          .number()
          .int()
          .optional()
          .describe("Optional Unix epoch timestamp (seconds) when evidence was observed"),
        autoRetireOnInvalid: z
          .boolean()
          .optional()
          .describe("If true and verdict is 'invalid', also soft-retire the memory (default: false)"),
        clientId: z
          .string()
          .optional()
          .describe("Client identifier recording the validation (default: 'mcp-validate')")
      })
    },
    async (args) => {
      const stub = getBrainStub();
      const result = await stub.validateMemory(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
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
              `1. Invoke \`log_episodic_event\` with \`eventType: "checkpoint"\` summarizing the workspace, verified outcomes, and any failed attempts.\n` +
              `2. For resolved bugs or infrastructure incidents, invoke \`remember_fact\` under namespace "${project}" using the structured troubleshooting template: **symptom**, **environment**, **root_cause**, **failed_attempts** (explicitly record what did NOT work), **corrective_action**, **verification**, and **prevention**.\n` +
              `3. For durable architectural choices or operational invariants, invoke \`log_decision\` with \`decision\`, \`rationale\`, \`rejectedOptions\` (why alternatives were rejected), and \`revisitWhen\` (conditions to reconsider).\n` +
              `4. For working preferences, include explicit **scope**, **exceptions**, and calibrated \`confidence\` (never store unqualified absolutes).\n` +
              `5. Invoke \`record_outcome\` with verified \`status\`, \`verifier\`, \`failedAttempts\`, and any \`citedMemoryIds\` that materially helped (or invoke \`validate_memory\` on any recalled fact confirmed or caught stale during the session).`
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
          code_challenge_methods_supported: ["S256"],
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
      const requestedRedirects = Array.isArray(regBody.redirect_uris)
        ? regBody.redirect_uris.filter((u): u is string => typeof u === "string")
        : [`${brainOrigin}/callback`];

      const invalidRedirects = requestedRedirects.filter(
        (uri) => !isAllowedRedirectUri(uri, brainOrigin, env.OAUTH_ALLOWED_REDIRECT_ORIGINS)
      );
      if (invalidRedirects.length > 0 || requestedRedirects.length === 0) {
        return Response.json(
          {
            error: "invalid_redirect_uri",
            error_description: "One or more redirect_uris are not permitted by this server."
          },
          { status: 400, headers: corsHeaders }
        );
      }

      return Response.json(
        {
          client_id: oauthClientId,
          client_name:
            typeof regBody.client_name === "string" && regBody.client_name.trim()
              ? regBody.client_name.trim().slice(0, 128)
              : "mcp-oauth-client",
          redirect_uris: requestedRedirects,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post"
        },
        { status: 201, headers: corsHeaders }
      );
    }

    const expectedToken = normalizeBearerToken(env.MCP_BEARER_TOKEN);
    const signingSecret = expectedToken;

    if (
      request.method === "GET" &&
      (url.pathname === "/authorize" || url.pathname === "/mcp/authorize")
    ) {
      if (!signingSecret) {
        return Response.json(
          {
            error: "server_error",
            error_description: "Server authentication signing secret is not configured."
          },
          { status: 503, headers: corsHeaders }
        );
      }

      const requestedClientId = url.searchParams.get("client_id") || "";
      if (requestedClientId && requestedClientId !== oauthClientId) {
        return Response.json(
          { error: "invalid_client", error_description: "Unknown OAuth client_id." },
          { status: 400, headers: corsHeaders }
        );
      }

      const callbackUri = `${brainOrigin}/callback`;
      const origRedirectUri = url.searchParams.get("redirect_uri") || callbackUri;
      if (!isAllowedRedirectUri(origRedirectUri, brainOrigin, env.OAUTH_ALLOWED_REDIRECT_ORIGINS)) {
        return Response.json(
          { error: "invalid_request", error_description: "Disallowed redirect_uri." },
          { status: 400, headers: corsHeaders }
        );
      }

      const origState = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = (
        url.searchParams.get("code_challenge_method") || "S256"
      ).toUpperCase();
      if (codeChallenge && codeChallengeMethod !== "S256" && codeChallengeMethod !== "PLAIN") {
        return Response.json(
          {
            error: "invalid_request",
            error_description: "Unsupported code_challenge_method."
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const signedState = await createSignedToken(
        "bstate",
        {
          r: origRedirectUri,
          s: origState,
          cc: codeChallenge,
          ccm: codeChallenge ? codeChallengeMethod : "",
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
      if (!signingSecret) {
        return Response.json(
          {
            error: "server_error",
            error_description: "Server authentication signing secret is not configured."
          },
          { status: 503, headers: corsHeaders }
        );
      }

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

      if (!decoded?.r) {
        return Response.json(
          {
            error: "invalid_request",
            error_description: "Invalid or expired OAuth state."
          },
          { status: 400, headers: corsHeaders }
        );
      }

      if (!isAllowedRedirectUri(decoded.r, brainOrigin, env.OAUTH_ALLOWED_REDIRECT_ORIGINS)) {
        return Response.json(
          { error: "invalid_request", error_description: "Disallowed redirect_uri in state." },
          { status: 400, headers: corsHeaders }
        );
      }

      const clientCallback = new URL(decoded.r);
      if (cfError || !cfCode) {
        clientCallback.searchParams.set("error", cfError || "access_denied");
        const errDesc = url.searchParams.get("error_description");
        if (errDesc) clientCallback.searchParams.set("error_description", errDesc);
      } else {
        // Wrap the upstream Cloudflare Access code into a short-lived signed envelope bound to
        // redirect_uri and PKCE challenge; POST /token redeems decodedCode.cf upstream with
        // Cloudflare Zero Trust before minting any Brain bearer token.
        const signedCode = await createSignedToken(
          "bcode",
          {
            cf: cfCode,
            r: decoded.r,
            cc: decoded.cc || "",
            ccm: decoded.ccm || "S256",
            exp: nowSec + 300
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

    if (
      request.method === "POST" &&
      (url.pathname === "/token" || url.pathname === "/mcp/token")
    ) {
      if (!signingSecret) {
        return Response.json(
          {
            error: "server_error",
            error_description: "Server authentication signing secret is not configured."
          },
          { status: 503, headers: { "Cache-Control": "no-store", ...corsHeaders } }
        );
      }

      const contentType = request.headers.get("Content-Type") || "";
      const rawBody = await request.text();
      let params: URLSearchParams;
      try {
        if (contentType.includes("application/json")) {
          const parsedObj = JSON.parse(rawBody || "{}") as Record<string, unknown>;
          params = new URLSearchParams();
          for (const [k, v] of Object.entries(parsedObj)) {
            if (typeof v === "string" || typeof v === "number") {
              params.set(k, String(v));
            }
          }
        } else {
          params = new URLSearchParams(rawBody);
        }
      } catch {
        return Response.json(
          { error: "invalid_request", error_description: "Malformed token request body." },
          { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
        );
      }

      const grantType = params.get("grant_type") || "authorization_code";
      const codeParam = params.get("code") || "";
      const refreshParam = params.get("refresh_token") || "";
      const codeVerifier = params.get("code_verifier") || "";
      const reqRedirectUri = params.get("redirect_uri") || "";
      const basicCreds = extractBasicAuthCredentials(request.headers.get("Authorization"));
      const providedClientId = basicCreds?.clientId || params.get("client_id") || "";
      const providedClientSecret =
        basicCreds?.clientSecret ||
        params.get("client_secret") ||
        env.OAUTH_CLIENT_SECRET ||
        "";
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Exchange signed authorization code ('bcode.*') by redeeming the wrapped Cloudflare Access
      //    code upstream at Cloudflare Zero Trust OIDC before minting Brain tokens.
      if (grantType === "authorization_code" && codeParam.startsWith("bcode.")) {
        if (providedClientId && providedClientId !== oauthClientId) {
          return Response.json(
            { error: "invalid_client", error_description: "Invalid OAuth client_id." },
            { status: 401, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const decodedCode = await verifySignedToken<{
          cf: string;
          r?: string;
          cc?: string;
          ccm?: string;
          exp?: number;
        }>(codeParam, "bcode", signingSecret);

        if (!decodedCode || !decodedCode.cf) {
          return Response.json(
            { error: "invalid_grant", error_description: "Invalid or expired authorization code." },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        if (reqRedirectUri && decodedCode.r && reqRedirectUri !== decodedCode.r) {
          return Response.json(
            { error: "invalid_grant", error_description: "redirect_uri mismatch." },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        // Mandatory RFC 7636 PKCE verification whenever code_challenge was supplied at /authorize
        if (!(await verifyPkceChallenge(codeVerifier, decodedCode.cc, decodedCode.ccm))) {
          return Response.json(
            { error: "invalid_grant", error_description: "PKCE code_verifier missing or mismatch." },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        // Redeem upstream Cloudflare Access authorization code (single-use & client-authenticated)
        const cfTokenParams = new URLSearchParams();
        cfTokenParams.set("grant_type", "authorization_code");
        cfTokenParams.set("code", decodedCode.cf);
        cfTokenParams.set("redirect_uri", `${brainOrigin}/callback`);
        cfTokenParams.set("client_id", oauthClientId);
        if (providedClientSecret) {
          cfTokenParams.set("client_secret", providedClientSecret);
        }

        let cfTokenRes: Response;
        try {
          cfTokenRes = await fetch(`${cfOidcBase}/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json"
            },
            body: cfTokenParams.toString(),
            redirect: "manual"
          });
        } catch {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Upstream Cloudflare Zero Trust token exchange unavailable."
            },
            { status: 502, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        if (!cfTokenRes.ok) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Upstream Cloudflare Zero Trust code verification failed."
            },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const cfTokenPayload = (await cfTokenRes.json().catch(() => null)) as {
          access_token?: string;
          id_token?: string;
        } | null;

        if (!cfTokenPayload || (!cfTokenPayload.id_token && !cfTokenPayload.access_token)) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Upstream Cloudflare Zero Trust response missing OIDC tokens."
            },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        let verifiedSub = "thomas-simon-primary-brain";
        let verifiedEmail: string | undefined;
        let upstreamIdentityValid = false;

        // Verify returned id_token or access_token cryptographically against Cloudflare JWKS
        for (const candidateJwt of [cfTokenPayload.id_token, cfTokenPayload.access_token]) {
          if (!candidateJwt) continue;
          const jwtResult = await verifyCloudflareOidcJwt(
            candidateJwt,
            cfOidcBase,
            oauthClientId
          );
          if (jwtResult.valid) {
            upstreamIdentityValid = true;
            if (jwtResult.sub) verifiedSub = jwtResult.sub;
            if (jwtResult.email) verifiedEmail = jwtResult.email;
            break;
          }
        }

        // Fallback to upstream /userinfo if Cloudflare returned an opaque access_token
        if (!upstreamIdentityValid && cfTokenPayload.access_token) {
          try {
            const uiRes = await fetch(`${cfOidcBase}/userinfo`, {
              headers: {
                Authorization: `Bearer ${cfTokenPayload.access_token}`,
                Accept: "application/json"
              }
            });
            if (uiRes.ok) {
              const uiJson = (await uiRes.json().catch(() => ({}))) as {
                sub?: string;
                email?: string;
              };
              upstreamIdentityValid = true;
              if (uiJson.sub) verifiedSub = uiJson.sub;
              if (uiJson.email) verifiedEmail = uiJson.email;
            }
          } catch {
            // Fail closed below
          }
        }

        if (!upstreamIdentityValid) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Upstream Cloudflare Zero Trust identity verification failed."
            },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const tokenClaims: Record<string, unknown> = {
          sub: verifiedSub,
          client_id: oauthClientId,
          iat: nowSec
        };
        if (verifiedEmail) {
          tokenClaims.email = verifiedEmail;
        }

        const accessToken = await createSignedToken(
          "bat",
          {
            ...tokenClaims,
            exp: nowSec + 2592000 // 30 days
          },
          signingSecret
        );
        const refreshToken = await createSignedToken(
          "brt",
          {
            ...tokenClaims,
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
        if (providedClientId && providedClientId !== oauthClientId) {
          return Response.json(
            { error: "invalid_client", error_description: "Invalid OAuth client_id." },
            { status: 401, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const decodedRefresh = await verifySignedToken<{
          sub: string;
          email?: string;
          client_id: string;
          exp?: number;
        }>(refreshParam, "brt", signingSecret);

        if (!decodedRefresh || decodedRefresh.client_id !== oauthClientId) {
          return Response.json(
            { error: "invalid_grant", error_description: "Invalid or expired refresh token." },
            { status: 400, headers: { "Cache-Control": "no-store", ...corsHeaders } }
          );
        }

        const refreshedClaims: Record<string, unknown> = {
          sub: decodedRefresh.sub,
          client_id: oauthClientId,
          iat: nowSec
        };
        if (decodedRefresh.email) {
          refreshedClaims.email = decodedRefresh.email;
        }

        const accessToken = await createSignedToken(
          "bat",
          {
            ...refreshedClaims,
            exp: nowSec + 2592000
          },
          signingSecret
        );
        const newRefreshToken = await createSignedToken(
          "brt",
          {
            ...refreshedClaims,
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
      const signedToken =
        signingSecret && provided
          ? await verifySignedToken<{ sub?: string; email?: string; exp?: number }>(
              provided,
              "bat",
              signingSecret
            )
          : null;
      const isPsk =
        Boolean(expectedToken) &&
        Boolean(provided) &&
        (await timingSafeStringEqual(provided, expectedToken));
      if (signedToken || isPsk) {
        return Response.json(
          {
            sub: signedToken?.sub || "thomas-simon-primary-brain",
            name: "Thomas Mathieu Simon",
            email: signedToken?.email || "thomas@tsimon.me",
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
          version: BRAIN_VERSION,
          endpoint: `${brainOrigin}/mcp`,
          dashboard: `${brainOrigin}/mcp?ui=1`,
          oauth_metadata: `${brainOrigin}/.well-known/oauth-authorization-server`,
          federated_sources: [
            "brain.tsimon.me (BrainMemoryDO + gemini-brain-bge-m3 1024-dim + bge-reranker-base)",
            "kb.tsimon.me (D1 archive-knowledge-db + archive-kb-index 768-dim)"
          ],
          tools: [
            "forget_memory",
            "get_overnight_diff",
            "hybrid_recall",
            "log_decision",
            "log_episodic_event",
            "record_outcome",
            "remember_fact",
            "resolve_conflict",
            "validate_memory"
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
      return new Response(
        renderDashboardHtml(env.PRIMARY_DOMAIN || "tsimon.me", BRAIN_VERSION),
        {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            ...corsHeaders
          }
        }
      );
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
      if (!expectedToken) {
        return Response.json(
          {
            ok: false,
            authError: "Server authentication is not configured (MCP_BEARER_TOKEN missing)."
          },
          { status: 503, headers: corsHeaders }
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const action = String(nocActionHeader || body.nocAction || url.searchParams.get("noc") || "dashboard");
      const providedToken = normalizeBearerToken(
        request.headers.get("Authorization") ||
          request.headers.get("X-Brain-Token") ||
          (typeof body._token === "string" ? body._token : "")
      );

      if (!providedToken || !(await timingSafeStringEqual(providedToken, expectedToken))) {
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

      if (action === "forget") {
        const forgetRes = await stub.forgetMemory({
          memoryId: typeof body.memoryId === "string" ? body.memoryId : "",
          mode: body.mode === "hard_delete" ? "hard_delete" : "soft_retire",
          reason: typeof body.reason === "string" ? body.reason : undefined,
          retireLinkedEdges: body.retireLinkedEdges !== false,
          clientId:
            typeof body.clientId === "string" ? body.clientId : "dashboard-noc-operator"
        });
        return Response.json(forgetRes, { status: 200, headers: corsHeaders });
      }

      if (action === "outcomes") {
        const outRes = await stub.getOutcomes({
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          status:
            body.status === "success" ||
            body.status === "partial" ||
            body.status === "failure" ||
            body.status === "abandoned"
              ? body.status
              : "all",
          hours: typeof body.hours === "number" ? body.hours : 720,
          limit: typeof body.limit === "number" ? body.limit : 40
        });
        return Response.json({ ok: true, ...outRes }, { status: 200, headers: corsHeaders });
      }

      if (action === "validate") {
        const verdict =
          body.verdict === "confirmed" || body.verdict === "weakened" || body.verdict === "invalid"
            ? body.verdict
            : "confirmed";
        const valRes = await stub.validateMemory({
          memoryId: typeof body.memoryId === "string" ? body.memoryId : "",
          verdict,
          evidenceUri: typeof body.evidenceUri === "string" ? body.evidenceUri : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
          autoRetireOnInvalid: body.autoRetireOnInvalid === true,
          clientId:
            typeof body.clientId === "string" ? body.clientId : "dashboard-noc-operator"
        });
        return Response.json(valRes, { status: 200, headers: corsHeaders });
      }
    }

    // 4. Dual-Mode Auth Gate (Fail-Closed): Fast-Path PSK (gemini-cli / Antigravity) + Signed Brain OAuth + Cloudflare OIDC
    if (!expectedToken) {
      return Response.json(
        {
          error: "Service Unavailable",
          error_description: "Server authentication is not configured."
        },
        { status: 503, headers: corsHeaders }
      );
    }

    const provided = normalizeBearerToken(
      request.headers.get("Authorization") || request.headers.get("X-Brain-Token")
    );
    const isPskValid = Boolean(provided) && (await timingSafeStringEqual(provided, expectedToken));
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

    if (request.method === "POST" && url.pathname === "/audit/forget") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["forgetMemory"]
      >[0];
      const result = await getBrainStub().forgetMemory(body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (url.pathname === "/audit/outcomes") {
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Parameters<
          BrainMemoryDO["recordOutcome"]
        >[0];
        if (!body.sessionId || !body.taskType || !body.query || !body.status || !body.resultSummary) {
          return Response.json(
            { ok: false, error: "sessionId, taskType, query, status, and resultSummary are required." },
            { status: 400 }
          );
        }
        const result = await getBrainStub().recordOutcome(body);
        return Response.json(result);
      }
      const list = await getBrainStub().getOutcomes({
        namespace: url.searchParams.get("namespace") ?? undefined,
        status: (url.searchParams.get("status") as "success" | "partial" | "failure" | "abandoned" | "all") || "all",
        hours: url.searchParams.get("hours") ? Number(url.searchParams.get("hours")) : 720,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 40
      });
      return Response.json({ ok: true, ...list });
    }

    if (request.method === "POST" && url.pathname === "/audit/validate") {
      const body = (await request.json().catch(() => ({}))) as Parameters<
        BrainMemoryDO["validateMemory"]
      >[0];
      const result = await getBrainStub().validateMemory(body);
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
    if (provided && !isPskValid) {
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
