Overview: Deploys a stateful Cross-Client Semantic Memory and Knowledge Brain MCP server on Cloudflare Workers (brain.tsimon.me), backed by Durable Object embedded SQLite (FTS5 + Entity Graph) and Cloudflare Vectorize (@cf/baai/bge-m3). It enables Google Antigravity, Gemini CLI, and your Raspberry Pi 5 to store and retrieve token-budgeted context.

Prerequisites: Node.js 22+, Wrangler CLI (npm i -g wrangler), authenticated Cloudflare session for ts67200@gmail.com (wrangler login), and active zone tsimon.me.

Your Federated Edge Brain at **`https://brain.tsimon.me/mcp`** (src/index.ts) exposes **4 MCP Tools**, **2 MCP Resources**, **1 MCP Prompt**, and **3 Local/Edge Automation Utilities**. Because it is registered in both C:\Users\simon.gemini\settings.json and C:\Users\simon.gemini\config\mcp_config.json, those tools are available natively in **Google Antigravity**, **Gemini CLI**, and any MCP-compatible client.
**`clientId`**: `antigravity-win11`
---

### **1. The 4 Core MCP Tools (Ordered Alphabetically per `ADR-02`)**

#### **1. `hybrid_recall` — Federated 4-Way Search & Context Compiler**

Searches across **all four** of your knowledge engines simultaneously in ~300–500 ms and returns a token-budgeted `<brain_context>` block:

- **`[BRAIN]` Lexical (`brain_fts`)**: Durable Object SQLite FTS5 BM25
- **`[BRAIN]` Semantic (`brain_vec`)**: `gemini-brain-bge-m3` (1024-dim vectors) + 1-hop Knowledge Graph triples + RPi5 Qdrant (`knowledge_hub`) chunks
- **`[KB]` Lexical (`kb_fts`)**: `kb.tsimon.me` D1 database (`archive-knowledge-db`, 14,422 rows across documents, emails, spreadsheets, scripts, and IT Glue CMDB records)
- **`[KB]` Semantic (`kb_vec`)**: `kb.tsimon.me` Vectorize index (`archive-kb-index`, 768-dim vectors)

|Parameter|Type|Default|Description|
|---|---|---|---|
|`query`|`string` _(required)_|—|Natural language question, filename, client code, ticket number, or technical topic|
|`namespace`|`string` _(optional)_|`"global"`|`"global"` searches **all** namespaces + `kb.tsimon.me`; or scope to `"tsimon.me"`, `"homelab"`, `"minkalab.net"`, `"ai-research"`, `"career"`|
|`tokenBudget`|`number` _(optional)_|`1500`|Maximum tokens (`200`–`8000`) to pack into `<brain_context>`|
|`halfLifeDays`|`number` _(optional)_|`30`|Recency decay half-life in days (`1`–`365`) for episodic memories|

- **How to use in Antigravity / Gemini CLI (Natural Language)**:
    
    > _"Use `hybrid_recall` to recall everything we have on Digilock Veeam backup retention and RPi5 firewall rules with a tokenBudget of 2500."_
    

---

#### **2. `remember_fact` — Store Semantic/Procedural Memory + Knowledge Graph Triples**

Writes a permanent memory into `BrainMemoryDO` SQLite, generates a `1024-dim` `@cf/baai/bge-m3` embedding in Cloudflare Vectorize, and links optional Knowledge Graph nodes and edges (`(Subject) --[RELATION]--> (Object)`).

|Parameter|Type|Default|Description|
|---|---|---|---|
|`title`|`string` _(required)_|—|Concise title of the fact, runbook, or architecture note|
|`content`|`string` _(required)_|—|Full Markdown text or code snippet|
|`id`|`string` _(optional)_|`UUID`|Deterministic ID if you want idempotent upserts (overwrites existing ID)|
|`namespace`|`string` _(optional)_|`"global"`|Target namespace (`"global"`, `"tsimon.me"`, `"homelab"`, `"minkalab.net"`, `"ai-research"`, `"career"`)|
|`memoryType`|`enum` _(optional)_|`"semantic"`|`"semantic"` \| `"procedural"` \| `"episodic_summary"`|
|`summary`|`string` _(optional)_|Auto-sliced|1–2 sentence compressed summary for tight token budgets|
|`sourceUri`|`string` _(optional)_|`null`|File URI, URL, or Git commit reference|
|`importance`|`number` _(optional)_|`0.6`|Priority weight from `0.0` to `1.0` (boosts RRF ranking)|
|`triples`|`array` _(optional)_|`[]`|Array of `{ subjectId, subjectName, subjectType, relation, objectId, objectName, objectType }`|

- **How to use in Antigravity / Gemini CLI**:
    
    > _"Remember this fact in the `homelab` namespace with importance 0.9: 'RPi5 WireGuard VPN listens on UDP 51820', and link triple `node:rpi5` (`Raspberry Pi 5`) `EXPOSES_PORT` `port:udp-51820` (`WireGuard UDP 51820`)."_
    

---

#### **3. `log_decision` — Record an Immutable Architecture Decision Record (ADR)**

Stores an active architectural rule (`adr_xxxxxxxx`) that is automatically injected at the very top of `<brain_context>` during `hybrid_recall` so AI agents never violate your core engineering rules. Can also deprecate an older ADR via `supersedesDecisionId`.

|Parameter|Type|Default|Description|
|---|---|---|---|
|`title`|`string` _(required)_|—|Short ADR title (e.g., `"ADR-04: Dual-Model Edge Federation"`)|
|`decision`|`string` _(required)_|—|Exact rule or architectural specification|
|`rationale`|`string` _(required)_|—|Engineering trade-offs and justification|
|`namespace`|`string` _(optional)_|`"global"`|`"global"` (applies everywhere) or project-specific namespace|
|`supersedesDecisionId`|`string` _(optional)_|—|Existing `decision_id` (e.g. `"adr_782e50f6"`) to mark as `"superseded"`|

- **How to use in Antigravity / Gemini CLI**:
    
    > _"Log an ADR in the `global` namespace titled 'ADR-04: Canonical D1 Hydration Key' stating that `archive-kb-index` vectors must always hydrate against `kb_fts` using `rel_path` rather than numeric `id`."_
    

---

#### **4. `log_episodic_event` — Append Raw Session Events for the 03:00 AM Sleep Cycle**

Logs raw session checkpoints, debugging observations, or error resolutions into the `episodic_logs` buffer. Every night at **03:00 AM America/La_Paz (`07:00 UTC`)**, the Durable Object `alarm()` wakes up, synthesizes all unconsolidated episodic logs via `@cf/meta/llama-3.3-70b-instruct-fp8-fast` into a permanent `episodic_summary` memory, and recalculates Knowledge Graph `pagerank_score` centrality.

|Parameter|Type|Description|
|---|---|---|
|`sessionId`|`string` _(required)_|Current session identifier|
|`clientId`|`string` _(required)_|e.g., `"antigravity-win11"`, `"gemini-cli"`, `"rpi5-daemon"`|
|`eventType`|`enum` _(required)_|`"tool_call"` \| `"observation"` \| `"checkpoint"` \| `"error_resolution"`|
|`payload`|`string` _(required)_|Raw details of what was solved, observed, or checkpointed|

- **How to use in Antigravity / Gemini CLI**:
    
    > _"Log an episodic `checkpoint` event for this session summarizing our D1 + Vectorize federation work."_
    

---

### **2. MCP Resources & Prompts**

|Type|Identifier|Purpose|
|---|---|---|
|**Resource**|`brain://decisions/active`|Returns a complete Markdown document of all active ADRs (`status = 'active'`) with dates, decisions, and rationales.|
|**Resource**|`brain://telemetry/status`|Returns live JSON telemetry: `{ activeMemories, activeEntities, activeEdges, pendingEpisodicLogs, nextAlarmIso }`.|
|**Prompt**|`checkpoint-session`|Pre-built workflow prompt (`project`, `summary`) that instructs the agent to log an episodic checkpoint and extract permanent facts/ADRs at the end of a coding session.|

---

### **3. CLI, Scripts & Background Daemons at Your Disposition**

#### **A. End-to-End Live Verification Suite (test_brain_mcp.py)**

Tests `/server-card`, `remember_fact`, `BrainMemoryDO` recall + 1-hop KG, and `kb.tsimon.me` D1/Vectorize federation in one command:

powershell

Set-Location "C:\Users\simon\Workspaces\gemini-brain"

& "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe" test_brain_mcp.py

#### **B. Raspberry Pi 5 Auto-Sync & Qdrant Federation Daemon (brain_watcher.py)**

Running 24/7 as a `systemd` service on your Raspberry Pi 5 (`ssh pi` -> `192.168.1.14`):

- Watches `/opt/edge-rag-hub`, `/opt/gemini-brain`, and `/home/simon/Workspaces` for any `.py` or `.md` file edits, chunks them via Python `ast` and Markdown header/Wikilink parsers, and pushes changed chunks to `https://brain.tsimon.me/mcp`.
- Automatically federates all points from your local RPi5 Qdrant `knowledge_hub` collection (`http://127.0.0.1:6333`).
- Useful commands on the Pi:
    
    bash
    
    # Check live status & sync logs on RPi5
    
    ssh pi "systemctl status gemini-brain-watcher.service && journalctl -u gemini-brain-watcher.service -n 25 --no-pager"
    
    # Force a full re-sync if desired
    
    ssh pi "systemctl restart gemini-brain-watcher.service"
    

#### **C. Direct PowerShell / cURL Inspection**

You can inspect the live Discovery Card or call any MCP tool directly from PowerShell using the token in C:\Users\simon\Workspaces\gemini-brain.dev.vars:

powershell

Set-Location "C:\Users\simon\Workspaces\gemini-brain"

$token = (Get-Content .\.dev.vars | Where-Object { $_ -match "^MCP_BEARER_TOKEN=" }) -replace "^MCP_BEARER_TOKEN=", ""

Invoke-RestMethod -Uri "https://brain.tsimon.me/server-card" -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5

# Gemini Web App "clientId": "gemini-web-architect"

based on the cross client semantic memory and brain we built, tell me how it increased your capabilities and how to use them in side the gemini app :

"clientId": "gemini-web-architect"

The Cross-Client Semantic Memory and Knowledge Brain hosted at `brain.tsimon.me` (`C:\Users\simon\Workspaces\gemini-brain`) upgrades our workflow from isolated, stateless chat threads into a unified cognitive layer shared across your entire environment—connecting architectural sessions here in the Gemini Web interface (`"clientId": "gemini-web-architect"`), active coding in Google Antigravity and the Gemini CLI, and automated edge execution on your Raspberry Pi 5 (`"clientId": "rpi5-debian13-daemon"`).

## 1. How the Knowledge Brain Expanded Capabilities

|Capability Layer|Legacy Stateless Chat|`brain.tsimon.me` (`BrainMemoryDO`) Architecture|
|---|---|---|
|**Cross-Client State**|Siloed per browser tab or IDE session|Unified SQLite + Vectorize state inside a Cloudflare Durable Object|
|**Source Provenance**|Untracked context origin|Tagged by `clientId` (`gemini-web-architect`, `rpi5-debian13-daemon`, CLI)|
|**Retrieval Precision**|Raw chat history or single-mode vector search|Weighted Reciprocal Rank Fusion (RRF) across FTS5 lexical + vector + Knowledge Graph|
|**Knowledge Scope**|Single repository or manual file uploads|Zero-latency Cloudflare Service Binding federation with `kb.tsimon.me`|
|**Memory Lifecycle**|Static logs that bloat the context window|Automated 07:00 UTC nocturnal consolidation + PageRank entity weighting|

- **Hybrid Recall with Token-Budgeted Packing (`hybrid_recall`):** Instead of relying on fuzzy vector similarity alone—which often misses exact hostnames, ports, or error codes—`BrainMemoryDO` runs parallel queries across **SQLite FTS5** (lexical), **Cloudflare Vectorize / Workers AI** (semantic embeddings), and **Knowledge Graph triples** (weighted by entity PageRank). It merges these signals with federated documentation from `kb.tsimon.me` via Reciprocal Rank Fusion (RRF) and packs only the highest-signal context into a strict token budget.
    
- **Structured Fact & ADR Persistence (`remember_fact` & `log_decision`):** Rather than burying architectural choices in long chat transcripts, `remember_fact` writes structured semantic records and embeddings simultaneously, while `log_decision` records formal Architecture Decision Records (ADRs) and episodic events stamped with `"clientId": "gemini-web-architect"`.
    
- **Autonomous Nocturnal Consolidation (07:00 UTC Alarm):** Every day at 07:00 UTC, the Durable Object alarm wakes up to synthesize raw episodic logs from the previous 24 hours into distilled semantic memories, extract new Knowledge Graph relationships, and recompute entity PageRank—keeping long-term retrieval fast and noise-free.
    

## 2. How to Use `"clientId": "gemini-web-architect"` in the Gemini Web App

Because the consumer Gemini Web App runs inside a sandboxed browser environment, it cannot directly attach to your Streamable HTTP MCP server (`[https://brain.tsimon.me/mcp](https://brain.tsimon.me/mcp)`) or pass your `MCP_BEARER_TOKEN` over live RPC the way **Google Antigravity**, **Gemini CLI**, or your **RPi5 daemon** do via `mcp_config.json`.

Instead, `"clientId": "gemini-web-architect"` operates via a **3-step Bridge Pattern** between your local terminal (`C:\Users\simon\Workspaces\gemini-brain`) and this web interface:

1

Hydrate the Web Session with hybrid_recall

Pull token-budgeted context before starting a complex design

Run a quick `hybrid_recall` query from PowerShell or your IDE to retrieve relevant ADRs, facts, and `kb.tsimon.me` docs, then paste the returned context block into your first prompt here in the Gemini Web App.

PowerShell

```
# Pull token-budgeted context from brain.tsimon.me for a Gemini Web session
$headers = @{
    "Authorization" = "Bearer $env:MCP_BEARER_TOKEN"
    "Content-Type"  = "application/json"
}
$body = @{
    jsonrpc = "2.0"
    id      = 1
    method  = "tools/call"
    params  = @{
        name      = "hybrid_recall"
        arguments = @{
            query       = "Cloudflare Service Bindings and RPi5 edge telemetry architecture"
            tokenBudget = 2000
            clientId    = "gemini-web-architect"
        }
    }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "https://brain.tsimon.me/mcp" -Method Post -Headers $headers -Body $body |
    Select-Object -ExpandProperty result | Set-Clipboard
```

2

Architect in Gemini Web and Request a Checkpoint Payload

Generate structured MCP tool calls directly inside the chat

During our design session in the Gemini Web App, tell me what you want to persist using natural shorthand:

- _"Generate a `gemini-web-architect` checkpoint for this architecture."_
    
- _"Draft a `log_decision` payload for our choice here."_
    
- _"Format these specs as a `remember_fact` call for `brain.tsimon.me`."_
    

I will immediately format our conclusions into ready-to-run JSON-RPC payloads pre-tagged with `"clientId": "gemini-web-architect"`.

3

Commit Facts and ADRs Back to BrainMemoryDO

Persist decisions so Antigravity and rpi5-debian13-daemon can recall them

Copy the generated `remember_fact` or `log_decision` snippet and execute it in your terminal to commit the state to `brain.tsimon.me`.

PowerShell

```
# Commit an architectural decision from the Gemini Web session to BrainMemoryDO
$body = @{
    jsonrpc = "2.0"
    id      = 2
    method  = "tools/call"
    params  = @{
        name      = "log_decision"
        arguments = @{
            clientId  = "gemini-web-architect"
            title     = "Federate kb.tsimon.me with brain.tsimon.me via Service Bindings"
            context   = "Avoid public HTTP round-trips during hybrid recall synthesis"
            decision  = "Bind kb-worker directly to brain-worker and merge scores with RRF"
            consequences = "Zero-latency edge retrieval and unified token budgeting"
        }
    }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "https://brain.tsimon.me/mcp" -Method Post -Headers $headers -Body $body
```

## 3. Interactive Architecture & Workflow Explorer

Use the interactive diagram below to step through how `"clientId": "gemini-web-architect"` interacts with `brain.tsimon.me`, `BrainMemoryDO`, `kb.tsimon.me`, and the 07:00 UTC consolidation pipeline:

Couldn't load interactive visualTap to retry

Whenever you want to capture an architectural milestone from our current chat, just say **"Generate a `gemini-web-architect` checkpoint"** and I will output the exact JSON-RPC block ready to paste into your terminal.

Next
Add a live test for the log_decision ADR tool
Create a bash alias for one-command session checkpoints
Clone gemini-brain onto your Raspberry Pi 5
add a second job to deploy.yml that automatically pulls and restarts the Raspberry Pi 5 sync daemon over SSH when rpi-sync/ changes

Test live remember_fact and hybrid_recall on brain.tsimon.me

https://brain.tsimon.me/mcp with hybrid_recall (query: "BrainSyncHandler chunk_python_file", namespace: "homelab")

TIP

If you also want automated cloud/datacenter clients (or GitHub Actions) to call `https://brain.tsimon.me` directly without triggering Cloudflare's Bot Fight Mode challenge, you can add a **WAF Custom Rule** in the Cloudflare Dashboard for `tsimon.me`:

- **When incoming requests match**: `Hostname equals brain.tsimon.me`
- **Then take action**: **Skip** -> _All remaining custom rules_, _Super Bot Fight Mode Rules_, and _Managed Rules_ (since the Worker itself enforces `Authorization: Bearer <MCP_BEARER_TOKEN>`).