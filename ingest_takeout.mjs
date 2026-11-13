/**
 * File: C:\Users\simon\Workspaces\gemini-brain\ingest_takeout.mjs
 * Purpose: Production ETL & Dual-Tier Ingestion Pipeline for Google Takeout:
 *          - AI Mode (MyActivity.json)
 *          - Assistant (MyActivity.json)
 *          - Gemini Apps (MyActivity.json + standalone Canvas Markdown exports)
 *          - Google Translate (MyActivity.json)
 *          - Search (MyActivity.json)
 *          - Gemini in Workspace Conversation History (conversation_*.txt JSON files)
 *
 * Routing Architecture:
 *   - Tier 1 (Active Brain -> BrainMemoryDO SQLite + FTS5 + 1-Hop KG + gemini-brain-bge-m3 1024d):
 *     High-signal distilled semantic/procedural memories, Gemini Canvas specs, Workspace syntheses,
 *     AI Mode technical deep-dives, Trilingual Lexicon, and Thematic Research Chronicles.
 *   - Tier 2 (Long-Term Archive -> D1 archive-knowledge-db files + kb_fts + archive-kb-index 768d):
 *     Complete verbatim conversation threads, Canvas artifacts, AI Mode answers, chronological
 *     Search session trails, Translate logs, and Assistant telemetry.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT_DIR = process.cwd();
const STAGING_DIR = path.join(ROOT_DIR, "takeout-staging");
const OUTPUT_DIR = path.join(ROOT_DIR, "takeout-output");
const STATE_FILE = path.join(OUTPUT_DIR, "ingest_state.json");

const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || "https://brain.tsimon.me";

function loadBearerToken() {
  if (process.env.MCP_BEARER_TOKEN) return process.env.MCP_BEARER_TOKEN.trim();
  const devVarsPath = path.join(ROOT_DIR, ".dev.vars");
  if (fs.existsSync(devVarsPath)) {
    const lines = fs.readFileSync(devVarsPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^MCP_BEARER_TOKEN=(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("MCP_BEARER_TOKEN not found in environment or .dev.vars");
}

function sha256Hex(input, len = 24) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, len);
}

function slugify(value) {
  return (
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unnamed"
  );
}

function toUnixSec(isoStr) {
  if (!isoStr) return Math.floor(Date.now() / 1000);
  const ms = Date.parse(isoStr);
  return Number.isNaN(ms) ? Math.floor(Date.now() / 1000) : Math.floor(ms / 1000);
}

/**
 * Decodes HTML entities and converts Google Takeout safeHtmlItem HTML into clean Markdown.
 */
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function cleanUrl(rawUrl) {
  if (!rawUrl) return "";
  let u = rawUrl.trim();
  try {
    if (u.startsWith("https://www.google.com/url?")) {
      const parsed = new URL(u);
      const q = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (q) u = q;
    }
    const parsed = new URL(u);
    for (const param of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "gad_source",
      "gad_campaignid",
      "gbraid",
      "gclid",
      "gclsrc",
      "srsltid",
      "pcampaignid",
      "referrer"
    ]) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString();
  } catch {
    return u;
  }
}

function htmlToMarkdown(html) {
  if (!html) return "";
  let text = String(html);

  // Strip script and style tags completely
  text = text.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Code blocks
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`;
  });
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`;
  });
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    return `\`${decodeHtmlEntities(code).trim()}\``;
  });

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");

  // Links
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
    const cleanedHref = cleanUrl(decodeHtmlEntities(href));
    if (!cleanLabel) return cleanedHref;
    return `[${cleanLabel}](${cleanedHref})`;
  });

  // Bold / Italic
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Lists & Paragraphs & Table cells
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, "\n$1");
  text = text.replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi, " | $2");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|blockquote|ul|ol|table)>/gi, "\n\n");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);

  // Clean whitespace
  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Extracts structured architectural text from interactive HTML Canvas apps (<!DOCTYPE html>)
 * while stripping 100KB+ of raw CSS/SVG coordinates.
 */
function extractInteractiveHtmlAppSpec(rawBody) {
  const titleMatch = rawBody.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].trim())
    : "Interactive Architecture Specification";

  // Extract body HTML + embedded JS data objects/descriptions
  const bodyMatch = rawBody.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : rawBody;
  const visibleMd = htmlToMarkdown(bodyHtml);

  // Also extract informative string literals from <script> blocks (titles, descriptions, steps)
  const scriptBlocks = [...rawBody.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1]
  );
  const extractedDataPoints = [];
  for (const sc of scriptBlocks) {
    const kvMatches = sc.matchAll(
      /\b(title|name|label|desc|description|summary|role|mechanism|detail|step|phase|layer|component)\s*:\s*["'`]([^"'`]{15,400})["'`]/gi
    );
    for (const m of kvMatches) {
      extractedDataPoints.push(`- **${m[1]}**: ${m[2].trim()}`);
    }
  }

  const uniqueDataPoints = [...new Set(extractedDataPoints)].slice(0, 60);
  const parts = [`# ${title} (Interactive Gemini Canvas Architecture App)`];
  if (visibleMd) {
    parts.push(`## Rendered Architecture Text\n${visibleMd}`);
  }
  if (uniqueDataPoints.length > 0) {
    parts.push(`## Interactive Component Specifications\n${uniqueDataPoints.join("\n")}`);
  }
  return {
    title,
    markdown: parts.join("\n\n").slice(0, 12000)
  };
}

/**
 * Infers the best Gemini Brain namespace ('tsimon.me', 'minkalab.net', 'homelab', 'career', 'ai-research', 'global')
 * and primary KB theme from title + text.
 */
function classifyNamespaceAndTheme(title, content) {
  const combined = `${title}\n${content}`.toLowerCase();

  if (
    /\b(minkalab|aynilab|pulpolab|clacso|ciudadan[ií]a digital|talleres pilotos|el alto|sopocachi|gamlp|autism|asd\b|neurodivers|domotics|dom[oó]tica)\b/.test(
      combined
    )
  ) {
    return {
      namespace: "minkalab.net",
      primaryTheme: "MinkaLab Civic Pedagogy & Digital Sovereignty",
      entityId: "domain:minkalab.net",
      entityName: "MinkaLab (minkalab.net)"
    };
  }

  if (
    /\b(tsimon\.me|human_context_architecture|editorial systems monograph|saul leiter|crewdson|kodachrome)\b/.test(
      combined
    )
  ) {
    return {
      namespace: "tsimon.me",
      primaryTheme: "tsimon.me Brand & Human Context Architecture",
      entityId: "domain:tsimon.me",
      entityName: "tsimon.me"
    };
  }

  if (
    /\b(mssp|synquery|outlier|alignerr|turing|oneforma|distantjob|freelanc|resume|cv\b|arctic wolf|contracting|airtm|career|salary|interview)\b/.test(
      combined
    )
  ) {
    return {
      namespace: "career",
      primaryTheme: "Career Sovereignty, MSSP Advisory & AI Contracting",
      entityId: "concept:ai-context-engineer",
      entityName: "Independent AI Trainer & Context Engineer"
    };
  }

  if (
    /\b(raspberry pi|rpi5|debian|qdrant|cloudflared|wireguard|hyper-v|homelab|esp32|nodemcu|adafruit|heatsink|ufw|docker|dns-over-https|health connect|galaxy watch)\b/.test(
      combined
    )
  ) {
    return {
      namespace: "homelab",
      primaryTheme: "Edge Infrastructure, Homelab & Cloudflare Operations",
      entityId: "node:rpi5",
      entityName: "Raspberry Pi 5 (Debian 13 Trixie)"
    };
  }

  if (
    /\b(transformer|karpathy|kv-cache|bge-m3|vectorize|durable object|mcp\b|model context protocol|ollama|gemma|llama|rag\b|neuroscience|manes|harness|context engineering|agent|az-104|python|sql)\b/.test(
      combined
    )
  ) {
    return {
      namespace: "ai-research",
      primaryTheme: "AI Context Engineering, LLM Internals & Cloud Architecture",
      entityId: "domain:brain.tsimon.me",
      entityName: "brain.tsimon.me (BrainMemoryDO)"
    };
  }

  return {
    namespace: "global",
    primaryTheme: "Personal Knowledge & Operations Archive",
    entityId: "person:thomas-simon",
    entityName: "Thomas Mathieu Simon"
  };
}

// =============================================================================
// 1. PARSE GEMINI APPS (MyActivity.json + 2 Standalone Canvas Files)
// =============================================================================
function processGeminiApps() {
  const dir = path.join(STAGING_DIR, "gemini-apps");
  const brainItems = [];
  const kbItems = [];

  // 1A. Standalone Canvas files in takeout-staging/gemini-apps/
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "MyActivity.json") continue;
    const fullPath = path.join(dir, entry);
    if (!fs.statSync(fullPath).isFile()) continue;

    const rawText = fs.readFileSync(fullPath, "utf8").trim();
    if (!rawText) continue;

    const mtimeIso = fs.statSync(fullPath).mtime.toISOString();
    const unixTs = toUnixSec(mtimeIso);
    const firstHeader = (rawText.match(/^#\s+(.+)$/m)?.[1] || entry).trim();
    const { namespace, primaryTheme, entityId, entityName } = classifyNamespaceAndTheme(
      firstHeader,
      rawText
    );

    const kbId = `tk_gemfile_${sha256Hex(entry, 20)}`;
    const relPath = `takeout/gemini-apps/${entry}.md`;
    kbItems.push({
      id: kbId,
      relPath,
      filename: `${entry}.md`,
      extension: ".md",
      topFolder: "takeout",
      subFolder: "gemini-apps",
      modifiedIso: mtimeIso,
      sourceType: "document",
      primaryTheme,
      subThemes: JSON.stringify(["Gemini Canvas Export", namespace]),
      title: `[Gemini Canvas] ${firstHeader}`,
      content: rawText.slice(0, 14000)
    });

    // Also chunk by ## sections for Tier 1 BrainMemoryDO
    const sections = rawText.split(/(?=^##\s+)/m).filter((s) => s.trim().length > 60);
    sections.forEach((sec, idx) => {
      const secHeading = (sec.match(/^#{1,3}\s+(.+)$/m)?.[1] || `Section ${idx + 1}`).trim();
      const chunkId = `tk_gemf_${sha256Hex(`${entry}:${idx}`, 20)}`;
      const chunkTitle = `${firstHeader} — ${secHeading}`;
      brainItems.push({
        id: chunkId,
        namespace,
        memoryType: sec.includes("```") ? "procedural" : "semantic",
        title: chunkTitle,
        content: sec.trim().slice(0, 6000),
        summary: sec
          .replace(/^#+\s+.+$/gm, "")
          .trim()
          .slice(0, 260),
        sourceUri: `takeout://gemini-apps/${entry}#${slugify(secHeading)}`,
        importance: 0.9,
        createdAt: unixTs,
        triples: [
          {
            subjectId: `doc:${slugify(entry)}`,
            subjectName: firstHeader.slice(0, 80),
            subjectType: "project",
            relation: "GOVERNED_BY",
            objectId: entityId,
            objectName: entityName,
            objectType: "concept"
          }
        ]
      });
    });
  }

  // 1B. MyActivity.json
  const activityPath = path.join(dir, "MyActivity.json");
  const rawActivity = JSON.parse(fs.readFileSync(activityPath, "utf8"));

  // Separate Canvas creations vs Prompt turns
  const canvasByTitle = new Map();
  const threadsByUrl = new Map();

  for (const item of rawActivity) {
    const title = String(item.title || "").trim();
    const timeIso = item.time || new Date().toISOString();

    // Filter out UI feedback & empty events
    if (
      title.startsWith("Cleared previous feedback") ||
      title.startsWith("Gave feedback:") ||
      title.startsWith("Selected preferred draft") ||
      title === "Used Gemini Apps"
    ) {
      continue;
    }

    // Handle Gemini Canvas creations
    if (title.startsWith("Created Gemini Canvas")) {
      const rawBody = item.subtitles?.[0]?.name || "";
      if (!rawBody.trim()) continue;

      let canvasTitle = title.replace(/^Created Gemini Canvas( titled)?\s*/i, "").trim();
      let cleanMarkdown = rawBody;
      let isInteractiveHtml = false;

      if (!canvasTitle || rawBody.includes("<!DOCTYPE html>")) {
        const extracted = extractInteractiveHtmlAppSpec(rawBody);
        if (!canvasTitle) canvasTitle = extracted.title;
        cleanMarkdown = extracted.markdown;
        isInteractiveHtml = true;
      }

      // Keep latest version per unique canvasTitle (MyActivity is reverse-chronological, but compare timestamps safely)
      const existing = canvasByTitle.get(canvasTitle);
      if (!existing || timeIso > existing.timeIso) {
        canvasByTitle.set(canvasTitle, {
          canvasTitle,
          timeIso,
          cleanMarkdown,
          isInteractiveHtml
        });
      }
      continue;
    }

    // Handle Prompted / Live Prompt / Used an Assistant turns
    const threadUrl =
      item.details?.[0]?.url || `https://gemini.google.com/app/unthreaded-${timeIso.slice(0, 10)}`;
    const promptText = title
      .replace(/^(Prompted|Live Prompt|Used an Assistant)\s*/i, "")
      .trim();
    const responseHtml = item.safeHtmlItem?.[0]?.html || "";
    const responseMd = htmlToMarkdown(responseHtml);
    const subtitleText =
      !responseMd && item.subtitles?.length
        ? item.subtitles.map((s) => s.name).join("\n")
        : "";

    if (!promptText && !responseMd && !subtitleText) continue;

    if (!threadsByUrl.has(threadUrl)) {
      threadsByUrl.set(threadUrl, []);
    }
    threadsByUrl.get(threadUrl).push({
      timeIso,
      promptText: promptText || "(Voice/Live Interaction)",
      responseMd: responseMd || subtitleText
    });
  }

  // Emit deduplicated Gemini Canvas Artifacts to Tier 2 (KB) and Tier 1 (Brain)
  for (const [, canvas] of canvasByTitle.entries()) {
    const { canvasTitle, timeIso, cleanMarkdown, isInteractiveHtml } = canvas;
    const unixTs = toUnixSec(timeIso);
    const { namespace, primaryTheme, entityId, entityName } = classifyNamespaceAndTheme(
      canvasTitle,
      cleanMarkdown
    );
    const slug = slugify(canvasTitle);
    const kbId = `tk_canvas_${sha256Hex(canvasTitle, 20)}`;
    const relPath = `takeout/gemini-canvas/${slug}.md`;

    kbItems.push({
      id: kbId,
      relPath,
      filename: `${slug}.md`,
      extension: ".md",
      topFolder: "takeout",
      subFolder: "gemini-canvas",
      modifiedIso: timeIso,
      sourceType: "document",
      primaryTheme,
      subThemes: JSON.stringify([
        "Gemini Canvas",
        isInteractiveHtml ? "Interactive HTML Architecture" : "Markdown Spec",
        namespace
      ]),
      title: `[Gemini Canvas] ${canvasTitle}`,
      content: cleanMarkdown.slice(0, 14000)
    });

    brainItems.push({
      id: kbId,
      namespace,
      memoryType: cleanMarkdown.includes("```") ? "procedural" : "semantic",
      title: `[Gemini Canvas] ${canvasTitle}`,
      content: cleanMarkdown.slice(0, 6500),
      summary: cleanMarkdown
        .replace(/^#+\s+.+$/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260),
      sourceUri: `takeout://gemini-canvas/${slug}`,
      importance: 0.88,
      createdAt: unixTs,
      triples: [
        {
          subjectId: `canvas:${slug}`,
          subjectName: `Gemini Canvas: ${canvasTitle.slice(0, 70)}`,
          subjectType: "project",
          relation: "ARCHIVED_IN_DOMAIN",
          objectId: entityId,
          objectName: entityName,
          objectType: "concept"
        },
        {
          subjectId: "person:thomas-simon",
          subjectName: "Thomas Mathieu Simon",
          subjectType: "person",
          relation: "AUTHORED_SPEC",
          objectId: `canvas:${slug}`,
          objectName: `Gemini Canvas: ${canvasTitle.slice(0, 70)}`,
          objectType: "project"
        }
      ]
    });
  }

  // Emit 73 Gemini Conversation Threads to Tier 2 (KB) and high-signal threads to Tier 1 (Brain)
  for (const [threadUrl, turns] of threadsByUrl.entries()) {
    turns.sort((a, b) => a.timeIso.localeCompare(b.timeIso));
    const threadId = threadUrl.split("/").pop() || sha256Hex(threadUrl, 12);
    const latestIso = turns[turns.length - 1].timeIso;
    const earliestIso = turns[0].timeIso;
    const unixTs = toUnixSec(latestIso);

    // Derive descriptive thread title from first substantive user prompt
    const firstMeaningfulPrompt =
      turns.find((t) => t.promptText.length > 15 && !t.promptText.startsWith("The response"))
        ?.promptText || turns[0].promptText;
    const shortTitle = firstMeaningfulPrompt
      .replace(/\s+/g, " ")
      .slice(0, 95)
      .trim();

    const formattedTurns = turns
      .map(
        (t, idx) =>
          `### Turn ${idx + 1} (${t.timeIso.slice(0, 16).replace("T", " ")} UTC)\n**Prompt:** ${t.promptText}\n\n**Gemini Response:**\n${t.responseMd || "_(No text response recorded)_"}`
      )
      .join("\n\n---\n\n");

    const fullTranscript = `# Gemini Conversation Thread: ${shortTitle}\n- **Thread URL:** ${threadUrl}\n- **Date Range:** ${earliestIso.slice(0, 10)} to ${latestIso.slice(0, 10)}\n- **Total Turns:** ${turns.length}\n\n${formattedTurns}`;

    const { namespace, primaryTheme, entityId, entityName } = classifyNamespaceAndTheme(
      shortTitle,
      fullTranscript
    );

    const kbId = `tk_gemthr_${sha256Hex(threadUrl, 20)}`;
    const relPath = `takeout/gemini-threads/${earliestIso.slice(0, 10)}_${threadId}.md`;

    kbItems.push({
      id: kbId,
      relPath,
      filename: `${earliestIso.slice(0, 10)}_${threadId}.md`,
      extension: ".md",
      topFolder: "takeout",
      subFolder: "gemini-threads",
      modifiedIso: latestIso,
      sourceType: "document",
      primaryTheme,
      subThemes: JSON.stringify(["Gemini Web App Thread", namespace]),
      title: `[Gemini Thread ${earliestIso.slice(0, 10)}] ${shortTitle}`,
      content: fullTranscript.slice(0, 14000)
    });

    // Promote substantive technical/architectural/project threads to Tier 1 BrainMemoryDO
    const totalResponseChars = turns.reduce((acc, t) => acc + (t.responseMd?.length || 0), 0);
    if (totalResponseChars >= 400) {
      brainItems.push({
        id: kbId,
        namespace,
        memoryType: fullTranscript.includes("```") ? "procedural" : "semantic",
        title: `[Gemini Session ${latestIso.slice(0, 10)}] ${shortTitle}`,
        content: fullTranscript.slice(0, 6000),
        summary: `Gemini ${turns.length}-turn session (${latestIso.slice(0, 10)}): ${shortTitle}`,
        sourceUri: threadUrl,
        importance: Math.min(0.86, 0.7 + Math.min(turns.length, 10) * 0.015),
        createdAt: unixTs,
        triples: [
          {
            subjectId: `thread:gemini-${threadId}`,
            subjectName: `Gemini Session: ${shortTitle.slice(0, 60)}`,
            subjectType: "concept",
            relation: "RELATES_TO_DOMAIN",
            objectId: entityId,
            objectName: entityName,
            objectType: "concept"
          }
        ]
      });
    }
  }

  return { brainItems, kbItems };
}

// =============================================================================
// 2. PARSE WORKSPACE GEMINI CONVERSATION HISTORY (conversation_*.txt JSON files)
// =============================================================================
function processWorkspaceGemini() {
  const dir = path.join(STAGING_DIR, "workspace-gemini");
  const brainItems = [];
  const kbItems = [];

  for (const file of sortedDirFiles(dir)) {
    if (!file.endsWith(".txt") && !file.endsWith(".json")) continue;
    const fullPath = path.join(dir, file);
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    const convId = file.replace(/\.(txt|json)$/i, "");
    const title = (raw.title || convId).trim().slice(0, 110);
    const modTimeIso =
      raw.last_modification_time || raw.creation_time || new Date().toISOString();
    const unixTs = toUnixSec(modTimeIso);

    const turns = raw.conversation_turns || [];
    const turnBlocks = [];
    const citedDocs = new Set();

    for (const t of turns) {
      if (t.user_turn) {
        const ts = (t.user_turn.turn_last_modified || modTimeIso).slice(0, 16).replace("T", " ");
        turnBlocks.push(`### User Prompt (${ts} UTC)\n${t.user_turn.prompt || ""}`);
      }
      if (t.system_turn) {
        const citations = (t.system_turn.citations || [])
          .map((c) => c.display_text)
          .filter(Boolean);
        citations.forEach((c) => citedDocs.add(c));

        const thoughts = (t.system_turn.model_thoughts || [])
          .map((th) => th.description?.trim())
          .filter(Boolean);

        const texts = (t.system_turn.text || [])
          .map((tx) => tx.data?.trim())
          .filter(Boolean);

        const sysParts = [];
        if (citations.length > 0) {
          sysParts.push(`**Cited Workspace Sources:** ${[...new Set(citations)].join(" | ")}`);
        }
        if (texts.length > 0) {
          sysParts.push(texts.join("\n\n"));
        } else if (thoughts.length > 0) {
          sysParts.push(`*(Model Synthesis)*:\n${thoughts[thoughts.length - 1]}`);
        }
        if (sysParts.length > 0) {
          turnBlocks.push(`### Workspace Gemini Response\n${sysParts.join("\n\n")}`);
        }
      }
    }

    const bodyMd = `# Gemini in Workspace Conversation: ${title}\n- **Conversation ID:** \`${convId}\`\n- **Timestamp:** ${modTimeIso}\n- **Cited Workspace Documents/Emails:** ${[...citedDocs].join("; ") || "None"}\n\n${turnBlocks.join("\n\n---\n\n")}`;

    const { namespace, primaryTheme, entityId, entityName } = classifyNamespaceAndTheme(
      title,
      bodyMd
    );

    const kbId = `tk_wsgem_${sha256Hex(convId, 20)}`;
    const relPath = `takeout/workspace-gemini/${convId}.md`;

    kbItems.push({
      id: kbId,
      relPath,
      filename: `${convId}.md`,
      extension: ".md",
      topFolder: "takeout",
      subFolder: "workspace-gemini",
      modifiedIso: modTimeIso,
      sourceType: "document",
      primaryTheme,
      subThemes: JSON.stringify(["Gemini in Workspace", namespace]),
      title: `[Workspace Gemini ${modTimeIso.slice(0, 10)}] ${title}`,
      content: bodyMd.slice(0, 14000)
    });

    const triples = [
      {
        subjectId: `wsconv:${convId}`,
        subjectName: `Workspace Gemini: ${title.slice(0, 65)}`,
        subjectType: "concept",
        relation: "SYNTHESIZES_FOR",
        objectId: entityId,
        objectName: entityName,
        objectType: "concept"
      }
    ];

    for (const docTitle of [...citedDocs].slice(0, 4)) {
      triples.push({
        subjectId: `wsconv:${convId}`,
        subjectName: `Workspace Gemini: ${title.slice(0, 65)}`,
        subjectType: "concept",
        relation: "CITES_WORKSPACE_ITEM",
        objectId: `wsdoc:${slugify(docTitle)}`,
        objectName: docTitle.slice(0, 80),
        objectType: "project"
      });
    }

    brainItems.push({
      id: kbId,
      namespace,
      memoryType: "semantic",
      title: `[Workspace Gemini ${modTimeIso.slice(0, 10)}] ${title}`,
      content: bodyMd.slice(0, 6000),
      summary: `Workspace Gemini synthesis (${modTimeIso.slice(0, 10)}): ${title} (Citations: ${[...citedDocs].slice(0, 3).join(", ") || "N/A"})`,
      sourceUri: `takeout://workspace-gemini/${convId}`,
      importance: 0.84,
      createdAt: unixTs,
      triples
    });
  }

  return { brainItems, kbItems };
}

// =============================================================================
// 3. PARSE AI MODE (MyActivity.json)
// =============================================================================
function processAiMode() {
  const filePath = path.join(STAGING_DIR, "ai-mode", "MyActivity.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const brainItems = [];
  const kbItems = [];

  for (const item of raw) {
    const rawTitle = String(item.title || "").trim();
    const html = item.safeHtmlItem?.[0]?.html || "";
    if (!html || rawTitle === "Used AI Mode") continue;

    const query = rawTitle.replace(/^Searched for\s+/i, "").trim();
    const timeIso = item.time || new Date().toISOString();
    const unixTs = toUnixSec(timeIso);
    const mdResponse = htmlToMarkdown(html);

    const fullMd = `# Google AI Mode Research: ${query}\n- **Date:** ${timeIso}\n- **Query:** \`${query}\`\n\n## AI Mode Synthesis\n${mdResponse}`;

    const { namespace, primaryTheme, entityId, entityName } = classifyNamespaceAndTheme(
      query,
      fullMd
    );

    const kbId = `tk_aimode_${sha256Hex(`${timeIso}:${query}`, 20)}`;
    const slug = slugify(query);
    const relPath = `takeout/ai-mode/${timeIso.slice(0, 10)}_${slug}.md`;

    kbItems.push({
      id: kbId,
      relPath,
      filename: `${timeIso.slice(0, 10)}_${slug}.md`,
      extension: ".md",
      topFolder: "takeout",
      subFolder: "ai-mode",
      modifiedIso: timeIso,
      sourceType: "document",
      primaryTheme,
      subThemes: JSON.stringify(["Google Search AI Mode", namespace]),
      title: `[AI Mode ${timeIso.slice(0, 10)}] ${query}`,
      content: fullMd.slice(0, 14000)
    });

    brainItems.push({
      id: kbId,
      namespace,
      memoryType: fullMd.includes("```") ? "procedural" : "semantic",
      title: `[AI Mode Research] ${query}`,
      content: fullMd.slice(0, 6000),
      summary: `AI Mode technical research (${timeIso.slice(0, 10)}) on "${query}": ${mdResponse.replace(/\s+/g, " ").slice(0, 200)}`,
      sourceUri: item.titleUrl || `takeout://ai-mode/${slug}`,
      importance: 0.82,
      createdAt: unixTs,
      triples: [
        {
          subjectId: "person:thomas-simon",
          subjectName: "Thomas Mathieu Simon",
          subjectType: "person",
          relation: "RESEARCHED_TOPIC",
          objectId: `topic:${slug}`,
          objectName: query.slice(0, 80),
          objectType: "concept"
        },
        {
          subjectId: `topic:${slug}`,
          subjectName: query.slice(0, 80),
          subjectType: "concept",
          relation: "APPLIES_TO",
          objectId: entityId,
          objectName: entityName,
          objectType: "concept"
        }
      ]
    });
  }

  return { brainItems, kbItems };
}

// =============================================================================
// 4. PARSE GOOGLE TRANSLATE (MyActivity.json)
// =============================================================================
function processTranslate() {
  const filePath = path.join(STAGING_DIR, "translate", "MyActivity.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

  // Deduplicate incremental typing / trailing whitespace lookups
  const uniqueMap = new Map();
  for (const item of raw) {
    const m = String(item.title || "").match(/^Translated\s+"([\s\S]*)"$/i);
    const term = (m ? m[1] : String(item.title || "")).trim();
    if (!term) continue;

    let sl = "auto";
    let tl = "unknown";
    if (item.titleUrl) {
      try {
        const u = new URL(item.titleUrl);
        sl = u.searchParams.get("sl") || "auto";
        tl = u.searchParams.get("tl") || "unknown";
      } catch {
        // ignore URL parse error
      }
    }

    const normKey = `${sl}->${tl}:${term.toLowerCase()}`;
    if (!uniqueMap.has(normKey)) {
      uniqueMap.set(normKey, {
        term,
        sl,
        tl,
        timeIso: item.time || new Date().toISOString(),
        url: item.titleUrl || ""
      });
    }
  }

  // Also filter out strict prefix typing fragments if a longer phrase at the same minute exists
  const allEntries = [...uniqueMap.values()].sort((a, b) => b.timeIso.localeCompare(a.timeIso));
  const filteredEntries = allEntries.filter((entry, idx) => {
    const isPrefixFragment = allEntries.some(
      (other, oIdx) =>
        oIdx !== idx &&
        other.sl === entry.sl &&
        other.tl === entry.tl &&
        Math.abs(Date.parse(other.timeIso) - Date.parse(entry.timeIso)) < 90_000 &&
        other.term.toLowerCase().startsWith(entry.term.toLowerCase()) &&
        other.term.length > entry.term.length
    );
    return !isPrefixFragment;
  });

  // Group by language pair (sl -> tl)
  const byPair = new Map();
  for (const e of filteredEntries) {
    const pair = `${e.sl.toUpperCase()} → ${e.tl.toUpperCase()}`;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push(e);
  }

  const sections = [];
  for (const [pair, list] of byPair.entries()) {
    const lines = list.map(
      (e) => `- **\`${e.term}\`** *(${e.timeIso.slice(0, 10)})*`
    );
    sections.push(`## Language Pair: ${pair} (${list.length} unique terms/phrases)\n${lines.join("\n")}`);
  }

  const latestIso = filteredEntries[0]?.timeIso || new Date().toISOString();
  const earliestIso =
    filteredEntries[filteredEntries.length - 1]?.timeIso || new Date().toISOString();
  const contentMd = `# Thomas Simon — Personal Trilingual Lexicon & Google Translate Corpus (ES / FR / EN)\n- **Date Range:** ${earliestIso.slice(0, 10)} to ${latestIso.slice(0, 10)}\n- **Raw Lookups:** ${raw.length} -> **Deduplicated Terms & Idioms:** ${filteredEntries.length}\n- **Context:** Active trilingual vocabulary, cultural idioms (La Paz / Spanish / French), and technical terminology.\n\n${sections.join("\n\n")}`;

  const kbId = "tk_translate_trilingual_lexicon_v1";
  const kbItem = {
    id: kbId,
    relPath: "takeout/translate/trilingual_lexicon_es_fr_en.md",
    filename: "trilingual_lexicon_es_fr_en.md",
    extension: ".md",
    topFolder: "takeout",
    subFolder: "translate",
    modifiedIso: latestIso,
    sourceType: "document",
    primaryTheme: "Trilingual Lexicon & Language Mastery (ES/FR/EN)",
    subThemes: JSON.stringify(["Google Translate", "Spanish", "French", "English"]),
    title: "[Google Translate Corpus] Personal Trilingual Lexicon (ES / FR / EN)",
    content: contentMd
  };

  const brainItem = {
    id: kbId,
    namespace: "global",
    memoryType: "semantic",
    title: "Personal Trilingual Lexicon & Phrasebook (Google Translate ES/FR/EN Corpus)",
    content: contentMd.slice(0, 6000),
    summary: `Deduplicated ES/FR/EN translation lexicon (${filteredEntries.length} unique terms/idioms from ${earliestIso.slice(0, 10)} to ${latestIso.slice(0, 10)}).`,
    sourceUri: "takeout://translate/MyActivity.json",
    importance: 0.83,
    createdAt: toUnixSec(latestIso),
    triples: [
      {
        subjectId: "person:thomas-simon",
        subjectName: "Thomas Mathieu Simon",
        subjectType: "person",
        relation: "CULTIVATES_LEXICON",
        objectId: "concept:trilingual-lexicon-es-fr-en",
        objectName: "Trilingual Lexicon (FR / EN / ES Idioms & Terminology)",
        objectType: "concept"
      }
    ]
  };

  return { brainItems: [brainItem], kbItems: [kbItem] };
}

// =============================================================================
// 5. PARSE SEARCH (MyActivity.json — 1,321 entries)
// =============================================================================
function processSearch() {
  const filePath = path.join(STAGING_DIR, "search", "MyActivity.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const brainItems = [];
  const kbItems = [];

  // Filter out Android notification dismissals & bare telemetry noise
  const cleanEvents = [];
  for (const item of raw) {
    const title = String(item.title || "").trim();
    if (
      /^\d+\s+notifications?$/i.test(title) ||
      title === "Used Search" ||
      title === "Google will" ||
      title === "Completed Circle" ||
      title.startsWith("Ran internet")
    ) {
      continue;
    }

    const timeIso = item.time || new Date().toISOString();
    const isSearch = title.startsWith("Searched for ");
    const isLens = title.startsWith("Searched with ");
    const action = isSearch ? "SEARCH" : isLens ? "LENS" : "VISIT";
    const text = title
      .replace(/^(Searched for|Visited|Viewed)\s+/i, "")
      .trim();
    if (!text) continue;

    const url = cleanUrl(item.titleUrl || "");
    cleanEvents.push({
      timeIso,
      action,
      text,
      url
    });
  }

  // Sort chronologically ascending
  cleanEvents.sort((a, b) => a.timeIso.localeCompare(b.timeIso));

  // 5A. Tier 2 (KB Archive): Group into Monthly Research & Web Trail Chronicles
  const byMonth = new Map();
  for (const ev of cleanEvents) {
    const monthKey = ev.timeIso.slice(0, 7); // YYYY-MM
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(ev);
  }

  for (const [monthKey, events] of byMonth.entries()) {
    // Group events within each month by day
    const byDay = new Map();
    for (const ev of events) {
      const dayKey = ev.timeIso.slice(0, 10);
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(ev);
    }

    const dayBlocks = [];
    for (const [dayKey, dayEvents] of byDay.entries()) {
      const lines = dayEvents.map((e) => {
        const hm = e.timeIso.slice(11, 16);
        const domain = (() => {
          try {
            return e.url ? new URL(e.url).hostname.replace(/^www\./, "") : "";
          } catch {
            return "";
          }
        })();
        const domainBadge =
          domain && domain !== "google.com" ? ` *(${domain})*` : "";
        return `- \`${hm}\` **[${e.action}]** ${e.text}${domainBadge}`;
      });
      dayBlocks.push(`### ${dayKey} (${dayEvents.length} events)\n${lines.join("\n")}`);
    }

    // Split large months into 2 parts if > 12,000 chars so D1 / FTS5 chunks stay crisp
    const fullMonthMd = `# Google Search & Web Research Trail — ${monthKey}\n- **Month:** ${monthKey}\n- **Total Meaningful Search & Visit Events:** ${events.length}\n\n${dayBlocks.join("\n\n")}`;

    if (fullMonthMd.length <= 13500) {
      const kbId = `tk_srch_${monthKey.replace("-", "_")}`;
      kbItems.push({
        id: kbId,
        relPath: `takeout/search/search_trail_${monthKey}.md`,
        filename: `search_trail_${monthKey}.md`,
        extension: ".md",
        topFolder: "takeout",
        subFolder: "search",
        modifiedIso: events[events.length - 1].timeIso,
        sourceType: "document",
        primaryTheme: "Chronological Search & Web Research Trail",
        subThemes: JSON.stringify(["Google Search History", monthKey]),
        title: `[Search Research Trail ${monthKey}] (${events.length} Queries & Visited Resources)`,
        content: fullMonthMd
      });
    } else {
      const mid = Math.ceil(dayBlocks.length / 2);
      const halves = [dayBlocks.slice(0, mid), dayBlocks.slice(mid)];
      halves.forEach((partBlocks, pIdx) => {
        const partNum = pIdx + 1;
        const kbId = `tk_srch_${monthKey.replace("-", "_")}_p${partNum}`;
        const partMd = `# Google Search & Web Research Trail — ${monthKey} (Part ${partNum}/2)\n- **Month:** ${monthKey} (Part ${partNum})\n\n${partBlocks.join("\n\n")}`;
        kbItems.push({
          id: kbId,
          relPath: `takeout/search/search_trail_${monthKey}_part${partNum}.md`,
          filename: `search_trail_${monthKey}_part${partNum}.md`,
          extension: ".md",
          topFolder: "takeout",
          subFolder: "search",
          modifiedIso: events[events.length - 1].timeIso,
          sourceType: "document",
          primaryTheme: "Chronological Search & Web Research Trail",
          subThemes: JSON.stringify(["Google Search History", monthKey]),
          title: `[Search Research Trail ${monthKey} Part ${partNum}] Queries & Visited Resources`,
          content: partMd.slice(0, 14000)
        });
      });
    }
  }

  // 5B. Tier 1 (BrainMemoryDO): Distill Search History into 5 Domain-Specific Research Chronicles
  const thematicBuckets = [
    {
      id: "tk_srch_theme_homelab_edge_v1",
      namespace: "homelab",
      title: "[Search Research Chronicle] Edge Infrastructure, Debian 13, RPi5, Cloudflare & Networking",
      entityId: "node:rpi5",
      entityName: "Raspberry Pi 5 (Debian 13 Trixie)",
      regex:
        /\b(cloudflare|cloudflared|raspberry|rpi|debian|linux|wireguard|dns|mullvad|adguard|hyper-v|windows 11|powershell|ssh|git\b|github|docker|wireshark|zenmap|ncdu|medicat|bitlocker|recoverykey|ost2pst|thunderbird|mailstore|kimsufi|ovh|health-connect|hcwebhook|arduino|esp32|adafruit)\b/i
    },
    {
      id: "tk_srch_theme_ai_context_v1",
      namespace: "ai-research",
      title: "[Search Research Chronicle] AI Context Engineering, Local LLMs, MCP, Obsidian & Python",
      entityId: "domain:brain.tsimon.me",
      entityName: "brain.tsimon.me (BrainMemoryDO)",
      regex:
        /\b(gemini|ollama|gemma|llama|antigravity|aistudio|copilot|mcp\b|obsidian|python|pyaudiowpatch|vscode|rag\b|vector|embedding|llm|openai|anthropic|quantum|ascii|markdown|udemy|oreilly|humblebundle|mit\b)\b/i
    },
    {
      id: "tk_srch_theme_photography_visual_v1",
      namespace: "tsimon.me",
      title: "[Search Research Chronicle] Documentary Photography, Saul Leiter, digiKam, darktable & Optics",
      entityId: "concept:leiter-crewdson-optics",
      entityName: "Saul Leiter & Gregory Crewdson Visual Grammar",
      regex:
        /\b(saul leiter|digikam|darktable|photography|photo|camera|sony|tamron|viltrox|smallrig|lenscratch|lenspiration|burn magazine|vivian|street|adobe|opencl|wallpaper|squarespace)\b/i
    },
    {
      id: "tk_srch_theme_career_contracting_v1",
      namespace: "career",
      title: "[Search Research Chronicle] AI Training Platforms, Remote Contracting & MSSP Research",
      entityId: "concept:ai-context-engineer",
      entityName: "Independent AI Trainer & Context Engineer",
      regex:
        /\b(outlier|oneforma|alignerr|turing|freelanc|mssp|earn|jobs|training llm|hootsuite|prstack|linkedin|paypal|airtm|banco|transferencia)\b/i
    },
    {
      id: "tk_srch_theme_lapaz_civic_v1",
      namespace: "minkalab.net",
      title: "[Search Research Chronicle] La Paz, Bolivia, Civic Context & Regional Ecosystem",
      entityId: "location:la-paz-bo",
      entityName: "La Paz, Bolivia (UTC-4)",
      regex:
        /\b(bolivia|la paz|urgentebo|tigo|psa\.com\.ar|c[eé]sar|biograf[ií]a|pawas|strasbourg|brumath)\b/i
    }
  ];

  for (const bucket of thematicBuckets) {
    const matched = cleanEvents.filter((e) => bucket.regex.test(`${e.text} ${e.url}`));
    if (matched.length === 0) continue;

    // Deduplicate identical query strings while keeping latest timestamp
    const dedup = new Map();
    for (const m of matched) {
      const k = m.text.toLowerCase();
      dedup.set(k, m);
    }
    const uniqueList = [...dedup.values()].sort((a, b) => b.timeIso.localeCompare(a.timeIso));
    const latestTs = toUnixSec(uniqueList[0].timeIso);

    const lines = uniqueList.slice(0, 120).map((m) => {
      const dateStr = m.timeIso.slice(0, 10);
      return `- \`${dateStr}\` **[${m.action}]** ${m.text}`;
    });

    const contentMd = `# ${bucket.title}\n- **Namespace:** \`${bucket.namespace}\`\n- **Total Matched Events:** ${matched.length} (${uniqueList.length} unique queries/resources)\n- **Date Range:** ${matched[0].timeIso.slice(0, 10)} to ${matched[matched.length - 1].timeIso.slice(0, 10)}\n\n## Chronological Research & Tool Investigation Log\n${lines.join("\n")}`;

    brainItems.push({
      id: bucket.id,
      namespace: bucket.namespace,
      memoryType: "semantic",
      title: bucket.title,
      content: contentMd.slice(0, 6000),
      summary: `Synthesized Google Search & web investigation trail (${uniqueList.length} unique queries/sites) for ${bucket.namespace}.`,
      sourceUri: `takeout://search/${bucket.id}`,
      importance: 0.8,
      createdAt: latestTs,
      triples: [
        {
          subjectId: "person:thomas-simon",
          subjectName: "Thomas Mathieu Simon",
          subjectType: "person",
          relation: "INVESTIGATED_DOMAIN",
          objectId: bucket.entityId,
          objectName: bucket.entityName,
          objectType: "concept"
        }
      ]
    });
  }

  return { brainItems, kbItems, cleanCount: cleanEvents.length, rawCount: raw.length };
}

// =============================================================================
// 6. PARSE GOOGLE ASSISTANT (MyActivity.json — 55 entries)
// =============================================================================
function processAssistant() {
  const filePath = path.join(STAGING_DIR, "assistant", "MyActivity.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const times = raw
    .map((x) => x.time)
    .filter(Boolean)
    .sort();
  const earliest = times[0] || new Date().toISOString();
  const latest = times[times.length - 1] || new Date().toISOString();

  // Group activation count by date
  const byDay = new Map();
  for (const t of times) {
    const d = t.slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const dayLines = [...byDay.entries()].map(([d, c]) => `- **${d}**: ${c} Assistant interaction(s)`);

  const contentMd = `# Google Assistant Activity Telemetry Summary\n- **Date Range:** ${earliest.slice(0, 10)} to ${latest.slice(0, 10)}\n- **Total Activations:** ${raw.length} ("Used Assistant" events across ${byDay.size} active days)\n- **Schema Note:** Google Takeout Assistant export contained activation timestamps without voice transcript payloads.\n\n## Daily Activation Frequency\n${dayLines.join("\n")}`;

  const kbId = "tk_assistant_telemetry_summary_v1";
  const kbItem = {
    id: kbId,
    relPath: "takeout/assistant/assistant_activity_summary.md",
    filename: "assistant_activity_summary.md",
    extension: ".md",
    topFolder: "takeout",
    subFolder: "assistant",
    modifiedIso: latest,
    sourceType: "document",
    primaryTheme: "Mobile & Voice Assistant Telemetry",
    subThemes: JSON.stringify(["Google Assistant", "Telemetry"]),
    title: `[Google Assistant Telemetry] Activity Summary (${earliest.slice(0, 10)} to ${latest.slice(0, 10)})`,
    content: contentMd
  };

  return { brainItems: [], kbItems: [kbItem], rawCount: raw.length };
}

function sortedDirFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

// =============================================================================
// BATCH UPLOAD ENGINE (WITH RETRY & LOCAL CHECKPOINT STATE)
// =============================================================================
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      return { brainHashes: {}, kbHashes: {} };
    }
  }
  return { brainHashes: {}, kbHashes: {} };
}

function saveState(state) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function postBatchWithRetry(url, token, payload, label) {
  let backoffMs = 1500;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`  [WARN] ${label} attempt ${attempt} failed (${err.message}). Retrying in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs *= 2;
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  console.log("=== STAGE 1: PARSING & DENOISING GOOGLE TAKEOUT SOURCES ===");
  const gemRes = processGeminiApps();
  console.log(
    ` -> [Gemini Apps + Canvas] Tier 1 Brain chunks: ${gemRes.brainItems.length} | Tier 2 KB docs: ${gemRes.kbItems.length}`
  );

  const wsRes = processWorkspaceGemini();
  console.log(
    ` -> [Workspace Gemini]     Tier 1 Brain chunks: ${wsRes.brainItems.length} | Tier 2 KB docs: ${wsRes.kbItems.length}`
  );

  const aiRes = processAiMode();
  console.log(
    ` -> [AI Mode]              Tier 1 Brain chunks: ${aiRes.brainItems.length} | Tier 2 KB docs: ${aiRes.kbItems.length}`
  );

  const trRes = processTranslate();
  console.log(
    ` -> [Google Translate]     Tier 1 Brain chunks: ${trRes.brainItems.length} | Tier 2 KB docs: ${trRes.kbItems.length}`
  );

  const srchRes = processSearch();
  console.log(
    ` -> [Google Search]        Raw: ${srchRes.rawCount} -> Clean: ${srchRes.cleanCount} | Tier 1 Brain chunks: ${srchRes.brainItems.length} | Tier 2 KB docs: ${srchRes.kbItems.length}`
  );

  const asstRes = processAssistant();
  console.log(
    ` -> [Google Assistant]     Raw: ${asstRes.rawCount} -> Consolidated Tier 2 KB doc: ${asstRes.kbItems.length}`
  );

  const allBrainItems = [
    ...gemRes.brainItems,
    ...wsRes.brainItems,
    ...aiRes.brainItems,
    ...trRes.brainItems,
    ...srchRes.brainItems,
    ...asstRes.brainItems
  ];

  const allKbItems = [
    ...gemRes.kbItems,
    ...wsRes.kbItems,
    ...aiRes.kbItems,
    ...trRes.kbItems,
    ...srchRes.kbItems,
    ...asstRes.kbItems
  ];

  // Export compiled Markdown corpus locally under takeout-output/ for inspection & RPi5 Qdrant sync
  fs.mkdirSync(path.join(OUTPUT_DIR, "tier1-brain"), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, "tier2-kb"), { recursive: true });

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "manifest_summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tier1BrainCount: allBrainItems.length,
        tier2KbCount: allKbItems.length,
        byNamespace: allBrainItems.reduce((acc, item) => {
          acc[item.namespace] = (acc[item.namespace] || 0) + 1;
          return acc;
        }, {})
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("\n=== SUMMARY OF COMPILED CORPUS ===");
  console.log(`Total Tier 1 (Active Brain / BrainMemoryDO + 1024d bge-m3): ${allBrainItems.length} memories`);
  console.log(`Total Tier 2 (Long-Term Archive / D1 KB_DB + 768d bge-base): ${allKbItems.length} documents`);

  if (dryRun) {
    console.log("\n[--dry-run enabled] Skipping network upload.");
    return;
  }

  const token = loadBearerToken();
  const state = force ? { brainHashes: {}, kbHashes: {} } : loadState();

  // Filter unchanged items using SHA-256 checkpoint hashes
  const pendingBrain = allBrainItems.filter((item) => {
    const h = sha256Hex(`${item.title}\n${item.content}\n${item.createdAt}`);
    item._hash = h;
    return state.brainHashes[item.id] !== h;
  });

  const pendingKb = allKbItems.filter((item) => {
    const h = sha256Hex(`${item.title}\n${item.content}\n${item.modifiedIso}`);
    item._hash = h;
    return state.kbHashes[item.id] !== h;
  });

  console.log(
    `\n=== STAGE 2: UPLOADING TO CLOUDFLARE EDGE (${BRAIN_BASE_URL}) ===`
  );
  console.log(
    `Pending Tier 1 Brain upserts: ${pendingBrain.length} / ${allBrainItems.length}`
  );
  console.log(
    `Pending Tier 2 KB upserts:    ${pendingKb.length} / ${allKbItems.length}`
  );

  // Batch upload Tier 1 Brain (10 items per batch)
  const BRAIN_BATCH_SIZE = 10;
  let brainUploaded = 0;
  for (let i = 0; i < pendingBrain.length; i += BRAIN_BATCH_SIZE) {
    const slice = pendingBrain.slice(i, i + BRAIN_BATCH_SIZE);
    const payload = {
      items: slice.map(({ _hash, ...rest }) => rest)
    };
    const res = await postBatchWithRetry(
      `${BRAIN_BASE_URL}/ingest/brain-batch`,
      token,
      payload,
      `BrainBatch[${i}..${i + slice.length - 1}]`
    );
    for (const item of slice) {
      state.brainHashes[item.id] = item._hash;
    }
    saveState(state);
    brainUploaded += slice.length;
    console.log(
      `  [Tier 1 Brain] Uploaded ${brainUploaded}/${pendingBrain.length} (vectors=${res.indexedVectors}, tokens=${res.totalTokens})`
    );
  }

  // Batch upload Tier 2 KB Archive (10 items per batch)
  const KB_BATCH_SIZE = 10;
  let kbUploaded = 0;
  for (let i = 0; i < pendingKb.length; i += KB_BATCH_SIZE) {
    const slice = pendingKb.slice(i, i + KB_BATCH_SIZE);
    const payload = {
      items: slice.map(({ _hash, ...rest }) => rest)
    };
    const res = await postBatchWithRetry(
      `${BRAIN_BASE_URL}/ingest/kb-batch`,
      token,
      payload,
      `KbBatch[${i}..${i + slice.length - 1}]`
    );
    for (const item of slice) {
      state.kbHashes[item.id] = item._hash;
    }
    saveState(state);
    kbUploaded += slice.length;
    console.log(
      `  [Tier 2 KB Archive] Uploaded ${kbUploaded}/${pendingKb.length} (D1=${res.ingestedD1}, vectors=${res.indexedVectors})`
    );
  }

  console.log("\n=== INGESTION COMPLETE ===");
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
