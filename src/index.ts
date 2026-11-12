/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\index.ts
 * Purpose: Stateless Streamable HTTP MCP v2 Server routing to BrainMemoryDO
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { BrainMemoryDO, type Env } from "./memory-do";

export { BrainMemoryDO };

function createBrainMcpServer(env: Env) {
  const server = new McpServer({
    name: "gemini-brain-mcp",
    version: "1.0.0"
  });

  // Always route to the singleton or namespace-scoped Durable Object instance
  const getBrainStub = () => {
    const id = env.BRAIN_DO.idFromName("thomas-simon-primary-brain");
    return env.BRAIN_DO.get(id);
  };

  // Tool 1 (Alphabetical Order #1): hybrid_recall
  server.registerTool(
    "hybrid_recall",
    {
      description:
        "Retrieve token-budgeted context using hybrid SQLite FTS5 BM25, Vectorize bge-m3 semantic similarity, and 1-hop knowledge graph expansion.",
      inputSchema: z.object({
        query: z.string().describe("Search query or technical topic to recall"),
        namespace: z.string().optional().describe("Project scope (e.g., 'global', 'tsimon.me', 'minkalab.net')"),
        tokenBudget: z.number().int().min(200).max(8000).optional().describe("Max tokens to return (default: 1500)"),
        halfLifeDays: z.number().min(1).max(365).optional().describe("Temporal decay half-life in days (default: 30)")
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

  // Tool 2 (Alphabetical Order #2): log_decision
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
        supersedesDecisionId: z.string().optional().describe("ID of an older ADR this decision replaces")
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

  // Tool 3 (Alphabetical Order #3): log_episodic_event
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

  // Tool 4 (Alphabetical Order #4): remember_fact
  server.registerTool(
    "remember_fact",
    {
      description:
        "Store a semantic or procedural memory in Durable Object SQLite, index its 1024-dim vector in Vectorize, and link optional knowledge graph triples.",
      inputSchema: z.object({
        id: z.string().optional().describe("Optional deterministic memory ID for idempotent upserts"),
        title: z.string().describe("Concise title of the memory chunk"),
        content: z.string().describe("Full Markdown or code block to store"),
        summary: z.string().optional().describe("1-2 sentence compressed summary for tight token budgets"),
        namespace: z.string().optional().describe("Namespace ('global', 'tsimon.me', 'minkalab.net', 'homelab')"),
        memoryType: z.enum(["semantic", "procedural", "episodic_summary"]).optional(),
        sourceUri: z.string().optional().describe("Originating file path, git commit, or URL"),
        importance: z.number().min(0).max(1).optional().describe("Salience weight from 0.0 to 1.0"),
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
    if (url.pathname === "/server-card" || url.pathname === "/.well-known/ai-catalog.json") {
      return Response.json({
        name: "gemini-brain-mcp",
        version: "1.0.0",
        endpoint: `https://brain.${env.PRIMARY_DOMAIN}/mcp`,
        tools: ["hybrid_recall", "log_decision", "log_episodic_event", "remember_fact"]
      });
    }

    return createMcpHandler(() => createBrainMcpServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;