/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\index.ts
 * Purpose: Stateless Streamable HTTP MCP v2 Server routing to BrainMemoryDO
 *          with 4-Way Federated Recall across BrainMemoryDO + kb.tsimon.me (D1 + Vectorize).
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { BrainMemoryDO, type Env } from "./memory-do";
import {
  KbFederationService,
  ingestKbArchiveBatch,
  type KbArchiveIngestItem
} from "./federation";

export { BrainMemoryDO, KbFederationService };

function createBrainMcpServer(env: Env) {
  const server = new McpServer({
    name: "gemini-brain-mcp",
    version: "1.1.0"
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
          .describe("Optional filter by clientId (e.g., 'rpi5-debian13-daemon', 'antigravity-win11-1', 'gemini-cli')"),
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
          .describe("Client identifier (e.g., 'antigravity-win11-1', 'gemini-cli', 'rpi5-daemon')"),
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
          .describe("Client identifier for mutation audit tracking (e.g., 'antigravity-win11-1', 'rpi5-debian13-daemon')"),
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

  // Resource 1: brain://decisions/active
  server.registerResource(
    "active-decisions",
    "brain://decisions/active",
    {
      title: "Active Architecture Decision Records (ADRs)",
      description: "Active ADRs governing the global and project namespaces.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const stub = getBrainStub();
      const markdown = await stub.getActiveDecisions("global");
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
        "Live counts of active memories, knowledge graph nodes/edges, unconsolidated episodic logs, and next nocturnal consolidation alarm.",
      mimeType: "application/json"
    },
    async (uri) => {
      const stub = getBrainStub();
      const stats = await stub.getNamespaceStats("global");
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
        "Pull the last 12-24 hours of memory mutations, RPi5 daemon syncs, and 03:00 AM consolidation digests to ground your first morning session.",
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
              `2. Summarize the key overnight mutations, Raspberry Pi 5 daemon syncs, new ADRs, and any nocturnal consolidation digests.\n` +
              `3. Highlight any modified facts or pending episodic events relevant to today's work.`
          }
        }
      ]
    })
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Optional Bearer Token check alongside Cloudflare Zero Trust Access
    if (env.MCP_BEARER_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.MCP_BEARER_TOKEN}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // SEP-2127 Static Discovery Card for zero-connection MCP capability inspection
    if (
      url.pathname === "/server-card" ||
      url.pathname === "/.well-known/ai-catalog.json" ||
      url.pathname === "/.well-known/mcp/server-card.json"
    ) {
      return Response.json({
        name: "gemini-brain-mcp",
        version: "1.2.0",
        endpoint: `https://brain.${env.PRIMARY_DOMAIN}/mcp`,
        federated_sources: [
          "brain.tsimon.me (BrainMemoryDO + gemini-brain-bge-m3 1024-dim + RPi5 Qdrant)",
          "kb.tsimon.me (D1 archive-knowledge-db + archive-kb-index 768-dim)"
        ],
        tools: [
          "get_overnight_diff",
          "hybrid_recall",
          "log_decision",
          "log_episodic_event",
          "remember_fact"
        ]
      });
    }

    const getBrainStub = () => {
      const id = env.BRAIN_DO.idFromName("thomas-simon-primary-brain");
      return env.BRAIN_DO.get(id);
    };

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

    return createMcpHandler(() => createBrainMcpServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
