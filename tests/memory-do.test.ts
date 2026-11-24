import { describe, it, expect } from "vitest";
import { BrainMemoryDO } from "../src/memory-do";
import { createMockDurableObjectState, createMockEnv } from "./mocks/do-sqlite-adapter";

async function createTestBrain() {
  const state = createMockDurableObjectState();
  const { env, vectorIndex } = createMockEnv();
  const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
  await state.waitUntilReady();
  return { brain, state, env, vectorIndex };
}

describe("BrainMemoryDO SQLite, FTS5, Governance, Guardrails & Rollback invariants", () => {
  it("upserts memories, records INSERT/UPDATE mutation diffs, and keeps FTS5 in sync", async () => {
    const { brain, state, vectorIndex } = await createTestBrain();

    const first = await brain.rememberFact({
      id: "mem-wg-port",
      namespace: "homelab",
      title: "WireGuard VPN Port",
      content: "WireGuard listens on UDP 51820.",
      importance: 0.9,
      confidence: 0.95,
      clientId: "vitest-runner"
    });
    expect(first.id).toBe("mem-wg-port");
    expect(first.mutationId).toBeGreaterThan(0);
    expect(vectorIndex.vectors.has("mem-wg-port")).toBe(true);

    const second = await brain.rememberFact({
      id: "mem-wg-port",
      namespace: "homelab",
      title: "WireGuard VPN Port",
      content: "WireGuard listens on UDP 51820 with persistent keepalive 25s.",
      importance: 0.92,
      confidence: 1.0,
      clientId: "vitest-runner"
    });
    expect(second.mutationId).toBeGreaterThan(first.mutationId!);

    const diff = await brain.getOvernightDiff({ hours: 24, memoryId: "mem-wg-port" });
    expect(diff.mutations.length).toBe(2);
    expect(diff.mutations[0].operation).toBe("UPDATE");
    expect(diff.mutations[0].old_content).toContain("UDP 51820.");
    expect(diff.mutations[0].new_content).toContain("keepalive 25s");

    const ftsHits = state.sql
      .exec<{ id: string }>(`SELECT id FROM memories_fts WHERE memories_fts MATCH '"keepalive"'`)
      .toArray();
    expect(ftsHits.map((r) => r.id)).toContain("mem-wg-port");
  });

  it("detects functional KG triple conflicts, supersedes cleanly, and restores expired edges on rollback", async () => {
    const { brain, state, vectorIndex } = await createTestBrain();

    // 1. Store original service host fact + functional RUNS_ON triple
    await brain.rememberFact({
      id: "mem-app-old",
      namespace: "tsimon.me",
      title: "Scout Worker Host",
      content: "scout.tsimon.me RUNS_ON vps-legacy.",
      triples: [
        {
          subjectId: "service:scout",
          subjectName: "scout.tsimon.me",
          subjectType: "service",
          relation: "RUNS_ON",
          objectId: "host:vps-legacy",
          objectName: "Legacy VPS",
          objectType: "device"
        }
      ]
    });

    // 2. Store new conflicting RUNS_ON target -> auto-flags triple_conflict
    await brain.rememberFact({
      id: "mem-app-new",
      namespace: "tsimon.me",
      title: "Scout Migrated to Cloudflare Workers",
      content: "scout.tsimon.me RUNS_ON cloudflare-workers.",
      triples: [
        {
          subjectId: "service:scout",
          subjectName: "scout.tsimon.me",
          subjectType: "service",
          relation: "RUNS_ON",
          objectId: "host:cf-workers",
          objectName: "Cloudflare Workers",
          objectType: "service"
        }
      ]
    });

    const conflicts = await brain.getMemoryConflicts({ status: "pending" });
    expect(conflicts.pendingCount).toBe(1);
    const conflict = conflicts.conflicts[0];
    expect(conflict.conflict_type).toBe("triple_conflict");
    expect(conflict.existing_edge_id).toBe("service:scout|RUNS_ON|host:vps-legacy");

    // 3. Supersede the old record & edge
    const resolved = await brain.resolveMemoryConflict({
      conflictId: conflict.conflict_id,
      action: "supersede",
      clientId: "vitest-triage"
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.vectorDeleted).toBe(true);
    expect(vectorIndex.vectors.has("mem-app-old")).toBe(false);

    // Verify FTS5 trigger removed superseded memory & edge has valid_until set
    const ftsOld = state.sql
      .exec<{ id: string }>(`SELECT id FROM memories_fts WHERE id = 'mem-app-old'`)
      .toArray();
    expect(ftsOld.length).toBe(0);

    const oldEdgeAfterSupersede = state.sql
      .exec<{ valid_until: number | null }>(
        `SELECT valid_until FROM edges WHERE edge_id = 'service:scout|RUNS_ON|host:vps-legacy'`
      )
      .one();
    expect(oldEdgeAfterSupersede.valid_until).not.toBeNull();

    // 4. Roll back the supersede mutation -> memory un-superseded, vector restored, AND KG edge restored!
    const rb = await brain.rollbackMutation({
      mutationId: resolved.mutationId,
      clientId: "vitest-rollback"
    });
    expect(rb.ok).toBe(true);
    expect(rb.action).toBe("RESTORED_PREVIOUS_VERSION");
    expect(rb.restoredEdgesCount).toBe(1);
    expect(vectorIndex.vectors.has("mem-app-old")).toBe(true);

    const oldEdgeAfterRollback = state.sql
      .exec<{ valid_until: number | null }>(
        `SELECT valid_until FROM edges WHERE edge_id = 'service:scout|RUNS_ON|host:vps-legacy'`
      )
      .one();
    expect(oldEdgeAfterRollback.valid_until).toBeNull();

    const ftsRestored = state.sql
      .exec<{ id: string }>(`SELECT id FROM memories_fts WHERE id = 'mem-app-old'`)
      .toArray();
    expect(ftsRestored.length).toBe(1);
  });

  it("retires non-protected linked KG edges when rolling back an INSERT mutation", async () => {
    const { brain, state, vectorIndex } = await createTestBrain();

    const ins = await brain.rememberFact({
      id: "mem-temp-insert",
      namespace: "homelab",
      title: "Temporary Test Service",
      content: "Temp service runs on test-box.",
      triples: [
        {
          subjectId: "service:temp-svc",
          subjectName: "Temp Service",
          relation: "RUNS_ON",
          objectId: "host:test-box",
          objectName: "Test Box"
        }
      ]
    });

    const rb = await brain.rollbackMutation({ mutationId: ins.mutationId });
    expect(rb.ok).toBe(true);
    expect(rb.action).toBe("DELETED_INSERTED_FACT");
    expect(rb.retiredEdgesCount).toBe(1);
    expect(vectorIndex.vectors.has("mem-temp-insert")).toBe(false);

    const edge = state.sql
      .exec<{ valid_until: number | null }>(
        `SELECT valid_until FROM edges WHERE edge_id = 'service:temp-svc|RUNS_ON|host:test-box'`
      )
      .one();
    expect(edge.valid_until).not.toBeNull();
  });

  it("protects node:rpi5 and service:rpi5-qdrant-knowledge-hub from supersede deprecation and insert rollback edge retirement", async () => {
    const { brain, state } = await createTestBrain();

    const ins = await brain.rememberFact({
      id: "mem-rpi5-qdrant",
      namespace: "homelab",
      title: "Raspberry Pi 5 Qdrant Edge Vault",
      content: "Qdrant knowledge hub runs on node:rpi5.",
      triples: [
        {
          subjectId: "service:rpi5-qdrant-knowledge-hub",
          subjectName: "RPi5 Qdrant Hub",
          subjectType: "service",
          relation: "RUNS_ON",
          objectId: "node:rpi5",
          objectName: "Raspberry Pi 5",
          objectType: "device"
        }
      ]
    });

    // Manually stage a conflict pointing at protected infrastructure and ensure supersede is blocked
    const cRow = state.sql
      .exec<{ conflict_id: number }>(
        `INSERT INTO memory_conflicts (
           namespace, conflict_type, severity, existing_memory_id, existing_edge_id,
           reason, suggested_action, status
         ) VALUES (
           'homelab', 'triple_conflict', 'high', 'mem-rpi5-qdrant',
           'service:rpi5-qdrant-knowledge-hub|RUNS_ON|node:rpi5',
           'Test guardrail', 'supersede', 'pending'
         ) RETURNING conflict_id`
      )
      .one();

    const blocked = await brain.resolveMemoryConflict({
      conflictId: cRow.conflict_id,
      action: "supersede"
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Safety Guardrail/i);

    // Rolling back an insert must NOT expire protected RPi5/Qdrant edge
    const rb = await brain.rollbackMutation({ mutationId: ins.mutationId });
    expect(rb.ok).toBe(true);
    expect(rb.retiredEdgesCount).toBe(0);

    const rpiEdge = state.sql
      .exec<{ valid_until: number | null }>(
        `SELECT valid_until FROM edges WHERE edge_id = 'service:rpi5-qdrant-knowledge-hub|RUNS_ON|node:rpi5'`
      )
      .one();
    expect(rpiEdge.valid_until).toBeNull();
  });

  it("increments access_count only for Brain memories packed into <brain_context> and enforces ADR supersession", async () => {
    const { brain, state } = await createTestBrain();

    const adr1 = await brain.logDecision({
      namespace: "global",
      title: "ADR-01 Legacy Hydration",
      decision: "Hydrate by numeric id.",
      rationale: "Initial draft"
    });
    await brain.logDecision({
      namespace: "global",
      title: "ADR-04 Canonical Hydration",
      decision: "Always hydrate archive-kb-index via rel_path.",
      rationale: "Avoid numeric ID collisions",
      supersedesDecisionId: adr1.decisionId
    });

    const activeAdrs = await brain.getActiveDecisions("global");
    expect(activeAdrs).toContain("ADR-04 Canonical Hydration");
    expect(activeAdrs).not.toContain("ADR-01 Legacy Hydration");

    // Store two facts; one matches the query, one does not
    await brain.rememberFact({
      id: "mem-matched",
      namespace: "global",
      title: "Cloudflare Durable Objects SQLite",
      content: "BrainMemoryDO stores FTS5 and property graph tables inside DO SQLite."
    });
    await brain.rememberFact({
      id: "mem-unmatched",
      namespace: "minkalab.net",
      title: "Unrelated Marketing Copy",
      content: "Landing page hero color palette and typography tokens."
    });

    const recalled = await brain.hybridRecall({
      query: "Durable Objects SQLite FTS5",
      namespace: "global",
      tokenBudget: 1500
    });

    expect(recalled.compiledMarkdown).toContain("ADR-04 Canonical Hydration");
    expect(recalled.compiledMarkdown).toContain("Cloudflare Durable Objects SQLite");

    const counts = state.sql
      .exec<{ id: string; access_count: number }>(
        `SELECT id, access_count FROM memories WHERE id IN ('mem-matched', 'mem-unmatched')`
      )
      .toArray();
    const byId = Object.fromEntries(counts.map((r) => [r.id, r.access_count]));
    expect(byId["mem-matched"]).toBe(1);
    // Unmatched record in another namespace may appear in global vector search or not; if not selected in candidates, count stays 0
    const wasUnmatchedSelected = recalled.candidates.some((c) => c.id === "brain:mem-unmatched");
    expect(byId["mem-unmatched"]).toBe(wasUnmatchedSelected ? 1 : 0);
  });

  it("prioritizes query-relevant older ADRs even when more than 8 newer ADRs exist", async () => {
    const { brain } = await createTestBrain();

    await brain.logDecision({
      namespace: "tsimon.me",
      title: "ADR-05: WAF-Safe /mcp?ui=1 Multiplexing",
      decision: "Multiplex browser NOC dashboard AJAX over POST /mcp?noc=<action> with HTTP 200 auth responses.",
      rationale: "Avoid Cloudflare WAF 403 rate-limit lockouts."
    });

    // Add 10 newer unrelated ADRs that previously pushed ADR-05 off LIMIT 8
    for (let i = 0; i < 10; i++) {
      await brain.logDecision({
        namespace: "global",
        title: `Newer Unrelated Policy #${i}`,
        decision: `Unrelated specification number ${i} covering general workflow standards and formatting conventions.`,
        rationale: "Routine policy update."
      });
    }

    await brain.rememberFact({
      id: "mem-noc-1",
      namespace: "tsimon.me",
      title: "Cognitive NOC Dashboard",
      content: "NOC dashboard runs at /mcp?ui=1."
    });

    const recalled = await brain.hybridRecall({
      query: "WAF-Safe /mcp?ui=1 Cognitive NOC ADR-05",
      namespace: "tsimon.me",
      tokenBudget: 1200
    });

    expect(recalled.compiledMarkdown).toContain("ADR-05");
  });

  it("supports forgetMemory soft_retire (reversible via rollback), hard_delete (scrubs audit), and RPi5 guardrails", async () => {
    const { brain, state, vectorIndex } = await createTestBrain();

    // 1. soft_retire + rollback restoration
    await brain.rememberFact({
      id: "mem-soft-target",
      namespace: "homelab",
      title: "Temporary Staging Port",
      content: "Staging worker ran on port 8799.",
      triples: [
        {
          subjectId: "service:staging-worker",
          subjectName: "Staging Worker",
          relation: "LISTENS_ON",
          objectId: "port:8799",
          objectName: "TCP 8799"
        }
      ]
    });

    const soft = await brain.forgetMemory({
      memoryId: "mem-soft-target",
      mode: "soft_retire",
      reason: "Decommissioned staging test port",
      clientId: "vitest-forget"
    });
    expect(soft.ok).toBe(true);
    expect(soft.mode).toBe("soft_retire");
    expect(soft.vectorDeleted).toBe(true);
    expect(soft.retiredEdgesCount).toBe(1);
    expect(vectorIndex.vectors.has("mem-soft-target")).toBe(false);

    const ftsAfterSoft = state.sql
      .exec<{ id: string }>(`SELECT id FROM memories_fts WHERE id = 'mem-soft-target'`)
      .toArray();
    expect(ftsAfterSoft.length).toBe(0);

    // Undo soft_retire via rollbackMutation -> restores memory, FTS5, vector, AND KG edge
    const undone = await brain.rollbackMutation({ mutationId: soft.mutationId });
    expect(undone.ok).toBe(true);
    expect(undone.restoredEdgesCount).toBe(1);
    expect(vectorIndex.vectors.has("mem-soft-target")).toBe(true);

    // 2. hard_delete permanently removes memory, edge, and scrubs historical audit content
    const hard = await brain.forgetMemory({
      memoryId: "mem-soft-target",
      mode: "hard_delete",
      reason: "Permanent cleanup of synthetic test record"
    });
    expect(hard.ok).toBe(true);
    expect(hard.mode).toBe("hard_delete");
    expect(hard.retiredEdgesCount).toBe(1);

    const remainingMem = state.sql
      .exec<{ id: string }>(`SELECT id FROM memories WHERE id = 'mem-soft-target'`)
      .toArray();
    expect(remainingMem.length).toBe(0);

    const scrubbedMutations = state.sql
      .exec<{ old_content: string | null; new_content: string | null }>(
        `SELECT old_content, new_content FROM memory_mutations WHERE memory_id = 'mem-soft-target'`
      )
      .toArray();
    for (const m of scrubbedMutations) {
      expect(m.old_content === null || m.old_content === "[HARD_DELETED]").toBe(true);
      expect(m.new_content === null || m.new_content === "[HARD_DELETED]").toBe(true);
    }

    // 3. Protected RPi5 / Qdrant record cannot be forgotten
    await brain.rememberFact({
      id: "fact-node:rpi5-core",
      namespace: "homelab",
      title: "Raspberry Pi 5 Core State",
      content: "node:rpi5 runs service:rpi5-qdrant-knowledge-hub."
    });
    const blocked = await brain.forgetMemory({
      memoryId: "fact-node:rpi5-core",
      mode: "hard_delete"
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Safety Guardrail/i);
  });

  it("preserves [episodic:<id>] provenance, navigational confidence=0.7, and non-flattening prompt in runConsolidationNow", async () => {
    const state = createMockDurableObjectState();
    let capturedSystemPrompt = "";
    let capturedUserLogs = "";
    const { env } = createMockEnv();
    const origRun = env.AI.run.bind(env.AI);
    env.AI = {
      async run(model: string, input: Record<string, unknown>) {
        if (model.includes("llama") && Array.isArray(input.messages)) {
          const msgs = input.messages as Array<{ role: string; content: string }>;
          if (msgs[0]?.content.includes("nocturnal memory consolidation")) {
            capturedSystemPrompt = msgs[0].content;
            capturedUserLogs = msgs[1]?.content || "";
            return {
              response:
                "## Summary\nHardened OAuth and fixed ADR packing.\n\n## Observed Facts\n- [episodic:1] OAuth patched.\n\n## Uncertainties\n- None."
            };
          }
        }
        return origRun(model as never, input as never);
      }
    } as unknown as typeof env.AI;

    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    const ev1 = await brain.logEpisodicEvent({
      sessionId: "sess-1",
      clientId: "antigravity-win11",
      eventType: "checkpoint",
      payload: "Hardened OAuth token redemption against Cloudflare Access."
    });
    const ev2 = await brain.logEpisodicEvent({
      sessionId: "sess-1",
      clientId: "antigravity-win11",
      eventType: "error_resolution",
      payload: "Failed attempt: all-or-nothing ADR block dropped ADR-05. Fix: incremental packing."
    });

    const res = await brain.runConsolidationNow("test_suite");
    expect(res.consolidatedCount).toBe(2);
    expect(res.digestMemoryId).toBeTruthy();

    // Prompt must pass [episodic:<id>] anchors and forbid silent contradiction resolution
    expect(capturedUserLogs).toContain(`[episodic:${ev1.logId}]`);
    expect(capturedUserLogs).toContain(`[episodic:${ev2.logId}]`);
    expect(capturedSystemPrompt).toMatch(/NEVER silently resolve/i);
    expect(capturedSystemPrompt).toMatch(/Failed Attempts/i);

    const savedRow = state.sql
      .exec<{ confidence: number; source_uri: string; metadata_json: string }>(
        `SELECT confidence, source_uri, metadata_json FROM memories WHERE id = ?1`,
        res.digestMemoryId
      )
      .one();
    expect(savedRow.confidence).toBeCloseTo(0.7, 2);
    expect(savedRow.source_uri).toContain(`logs=${ev1.logId},${ev2.logId}`);
    const meta = JSON.parse(savedRow.metadata_json) as {
      provenance_tier: string;
      source_log_ids: number[];
    };
    expect(meta.provenance_tier).toBe("llm_digest");
    expect(meta.source_log_ids).toEqual([ev1.logId, ev2.logId]);
  });

  it("formats structured rejectedOptions and revisitWhen inside logDecision ADRs", async () => {
    const { brain } = await createTestBrain();

    await brain.logDecision({
      namespace: "homelab",
      title: "Remote Access Overlay Choice",
      decision: "Use Tailscale for homelab mesh access.",
      rationale: "Works behind CGNAT with minimal ops overhead.",
      rejectedOptions: [
        "WireGuard port forwarding: blocked by ISP CGNAT",
        "Cloudflare Tunnel: unsuitable for arbitrary L3 UDP traffic"
      ],
      revisitWhen: ["More than 20 homelab nodes", "Site-to-site BGP routing required"]
    });

    const md = await brain.getActiveDecisions("homelab");
    expect(md).toContain("**Rejected Options**:");
    expect(md).toContain("WireGuard port forwarding");
    expect(md).toContain("**Revisit When**:");
    expect(md).toContain("More than 20 homelab nodes");
  });

  it("records task outcomes, guards against unverified LLM self-attribution, and nudges confidence only on verified outcomes", async () => {
    const { brain, state } = await createTestBrain();

    await brain.rememberFact({
      id: "mem-az-rbac",
      namespace: "homelab",
      title: "AZ-104 RBAC Role Assignment",
      content: "Assign least-privilege roles at resource group scope.",
      confidence: 0.75
    });

    // 1. Unverified outcome (no verifier, no operatorFeedback) MUST NOT mutate memory confidence
    const unverified = await brain.recordOutcome({
      sessionId: "sess-eval-1",
      namespace: "homelab",
      taskType: "research",
      query: "AZ-104 RBAC study",
      status: "success",
      resultSummary: "Reviewed RBAC concepts.",
      citedMemoryIds: ["brain:mem-az-rbac"]
    });
    expect(unverified.ok).toBe(true);
    expect(unverified.updatedMemoryIds).toEqual([]);
    expect(unverified.episodicLogId).toBeGreaterThan(0);

    const afterUnverified = state.sql
      .exec<{ confidence: number; validated_count: number }>(
        `SELECT confidence, validated_count FROM memories WHERE id = 'mem-az-rbac'`
      )
      .one();
    expect(afterUnverified.confidence).toBeCloseTo(0.75, 3);
    expect(afterUnverified.validated_count).toBe(0);

    // 2. Verified success outcome gently nudges confidence (+0.05) & increments validated_count
    const verifiedSuccess = await brain.recordOutcome({
      sessionId: "sess-eval-1",
      namespace: "homelab",
      taskType: "ops",
      query: "Apply Azure RBAC lab",
      status: "success",
      resultSummary: "az role assignment create succeeded.",
      failedAttempts: "Tried Subscription scope first; rejected by policy.",
      citedMemoryIds: ["brain:mem-az-rbac"],
      verifier: "az-cli",
      operatorFeedback: 1
    });
    expect(verifiedSuccess.updatedMemoryIds).toEqual(["mem-az-rbac"]);

    const afterSuccess = state.sql
      .exec<{ confidence: number; validated_count: number }>(
        `SELECT confidence, validated_count FROM memories WHERE id = 'mem-az-rbac'`
      )
      .one();
    expect(afterSuccess.confidence).toBeCloseTo(0.8, 3);
    expect(afterSuccess.validated_count).toBe(1);

    // 3. Failure with operatorFeedback=-1 nudges confidence down (-0.10) & increments invalidated_count
    await brain.recordOutcome({
      sessionId: "sess-eval-2",
      namespace: "homelab",
      taskType: "bug_fix",
      query: "Re-test stale RBAC CLI flag",
      status: "failure",
      resultSummary: "Deprecated flag rejected.",
      failedAttempts: "Passed --assignee-object-id without --assignee-principal-type.",
      citedMemoryIds: ["mem-az-rbac"],
      operatorFeedback: -1
    });

    const afterFail = state.sql
      .exec<{ confidence: number; invalidated_count: number }>(
        `SELECT confidence, invalidated_count FROM memories WHERE id = 'mem-az-rbac'`
      )
      .one();
    expect(afterFail.confidence).toBeCloseTo(0.7, 3);
    expect(afterFail.invalidated_count).toBe(1);

    // 4. Verify outcomes appear in getOutcomes() and getOvernightDiff()
    const outList = await brain.getOutcomes({ namespace: "homelab" });
    expect(outList.total).toBe(3);
    expect(outList.successRate).toBeCloseTo(2 / 3, 2);

    const diff = await brain.getOvernightDiff({ hours: 24, namespace: "homelab" });
    expect(diff.summary.outcomesRecorded).toBe(3);
    expect(diff.hydrationMarkdown).toContain("Recent Verified Outcomes");
    expect(diff.hydrationMarkdown).toContain("Failed attempts:");
  });

  it("validates memories with evidence (confirmed / weakened / invalid + autoRetireOnInvalid) and respects RPi5 guardrails", async () => {
    const { brain, state, vectorIndex } = await createTestBrain();

    const oldTs = Math.floor(Date.now() / 1000) - 60 * 86400; // 60 days old
    await brain.rememberFact({
      id: "mem-wg-validate",
      namespace: "homelab",
      title: "WireGuard Port Config",
      content: "WireGuard uses UDP 51820.",
      confidence: 0.6,
      createdAt: oldTs
    });

    // 1. Confirmed -> raises confidence to >= 0.90 and refreshes updated_at to reset decay
    const conf = await brain.validateMemory({
      memoryId: "brain:mem-wg-validate",
      verdict: "confirmed",
      evidenceUri: "ssh://pi/etc/wireguard/wg0.conf",
      notes: "Verified active ListenPort = 51820 on RPi5"
    });
    expect(conf.ok).toBe(true);
    expect(conf.newConfidence).toBeGreaterThanOrEqual(0.9);
    expect(conf.validatedCount).toBe(1);

    const rowAfterConf = state.sql
      .exec<{ updated_at: number; last_validated_at: number }>(
        `SELECT updated_at, last_validated_at FROM memories WHERE id = 'mem-wg-validate'`
      )
      .one();
    expect(rowAfterConf.updated_at).toBeGreaterThan(oldTs);
    expect(rowAfterConf.last_validated_at).toBeGreaterThan(oldTs);

    // 2. Weakened -> lowers confidence by 0.30
    const weak = await brain.validateMemory({
      memoryId: "mem-wg-validate",
      verdict: "weakened",
      notes: "Port migration planned"
    });
    expect(weak.ok).toBe(true);
    expect(weak.newConfidence).toBeCloseTo(0.6, 2);
    expect(weak.invalidatedCount).toBe(1);

    // 3. Invalid + autoRetireOnInvalid -> confidence=0.05 & soft-retires memory + deletes vector
    const inv = await brain.validateMemory({
      memoryId: "mem-wg-validate",
      verdict: "invalid",
      notes: "Replaced by Tailscale",
      autoRetireOnInvalid: true
    });
    expect(inv.ok).toBe(true);
    expect(inv.newConfidence).toBe(0.05);
    expect(inv.retired).toBe(true);
    expect(vectorIndex.vectors.has("mem-wg-validate")).toBe(false);

    const logCount = state.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM memory_validations WHERE memory_id = 'mem-wg-validate'`
      )
      .one().count;
    expect(logCount).toBe(3);
  });

  it("filters legacy noisy MCP handshake tool_call rows out of nocturnal consolidation while draining them", async () => {
    const state = createMockDurableObjectState();
    let llamaConsolidationCalls = 0;
    let capturedUserLogs = "";
    const { env } = createMockEnv();
    const origRun = env.AI.run.bind(env.AI);
    env.AI = {
      async run(model: string, input: Record<string, unknown>) {
        if (model.includes("llama") && Array.isArray(input.messages)) {
          const msgs = input.messages as Array<{ role: string; content: string }>;
          if (msgs[0]?.content.includes("nocturnal memory consolidation")) {
            llamaConsolidationCalls++;
            capturedUserLogs = msgs[1]?.content || "";
            return {
              response: "## Summary\nSubstantive work consolidated.\n\n## Observed Facts\n- [episodic:4] Real change."
            };
          }
        }
        return origRun(model as never, input as never);
      }
    } as unknown as typeof env.AI;

    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    // Case 1: Purely noisy legacy rows -> drain without invoking Llama or creating an empty digest
    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "initialize", status: 200 })
    });
    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "notifications/initialized", status: 202 })
    });
    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "tools/list", status: 200 })
    });

    const noiseOnlyRes = await brain.runConsolidationNow("test_noise_only");
    expect(noiseOnlyRes.consolidatedCount).toBe(3);
    expect(noiseOnlyRes.digestMemoryId).toBeNull();
    expect(llamaConsolidationCalls).toBe(0);

    const remainingPending1 = state.sql
      .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM episodic_logs WHERE consolidated = 0`)
      .one().c;
    expect(remainingPending1).toBe(0);

    // Case 2: Mixed noisy 2xx rows + substantive checkpoint + 500 error -> prompt excludes 2xx noise, keeps checkpoint & 500 error, drains all
    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "initialize", status: 200 })
    });
    const realEv = await brain.logEpisodicEvent({
      sessionId: "sess-real",
      clientId: "antigravity-win11",
      eventType: "checkpoint",
      payload: "Deployed v1.7.2 episodic noise filter."
    });
    const errEv = await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "tools/list", status: 500 })
    });

    const mixedRes = await brain.runConsolidationNow("test_mixed");
    expect(mixedRes.consolidatedCount).toBe(3);
    expect(mixedRes.digestMemoryId).toBeTruthy();
    expect(llamaConsolidationCalls).toBe(1);
    expect(capturedUserLogs).toContain(`[episodic:${realEv.logId}]`);
    expect(capturedUserLogs).toContain(`[episodic:${errEv.logId}]`);
    expect(capturedUserLogs).not.toContain('"rpcMethod":"initialize"');

    const savedRow = state.sql
      .exec<{ metadata_json: string }>(
        `SELECT metadata_json FROM memories WHERE id = ?1`,
        mixedRes.digestMemoryId
      )
      .one();
    const meta = JSON.parse(savedRow.metadata_json) as {
      source_log_ids: number[];
      filtered_noise_count: number;
    };
    expect(meta.source_log_ids).toEqual([realEv.logId, errEv.logId]);
    expect(meta.filtered_noise_count).toBe(1);

    const remainingPending2 = state.sql
      .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM episodic_logs WHERE consolidated = 0`)
      .one().c;
    expect(remainingPending2).toBe(0);
  });

  it("chunks large reindexMemories batches below Workers AI bge-m3 60,000-token context limit", async () => {
    const state = createMockDurableObjectState();
    const { env, vectorIndex } = createMockEnv();
    const origRun = env.AI.run.bind(env.AI);

    const observedBatches: Array<{ count: number; totalChars: number; truncateInputs?: boolean }> = [];
    env.AI = {
      async run(model: string, input: Record<string, unknown>) {
        if (model === "@cf/baai/bge-m3" && Array.isArray(input.text)) {
          const texts = input.text as string[];
          const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
          observedBatches.push({
            count: texts.length,
            totalChars,
            truncateInputs: input.truncate_inputs as boolean | undefined
          });
          // Simulate Workers AI 8007 rejection if a batch ever gets too large
          if (totalChars > 30_000 || texts.length > 16) {
            throw new Error("8007: Max context reached 63550 tokens but model supports only 60000");
          }
        }
        return origRun(model as never, input as never);
      }
    } as unknown as typeof env.AI;

    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    // Seed 50 large memories (~3,600 chars each, ~180k chars total) directly into SQLite
    const longBody = "Cloudflare Workers Durable Object SQLite FTS5 Vectorize ".repeat(70);
    state.sql.exec("BEGIN");
    for (let i = 0; i < 50; i++) {
      state.sql.exec(
        `INSERT INTO memories (id, namespace, memory_type, title, content, summary, token_count)
         VALUES (?1, 'global', 'semantic', ?2, ?3, 'summary', 950)`,
        `mem-bulk-${i}`,
        `Bulk Memory #${i}`,
        longBody
      );
    }
    state.sql.exec("COMMIT");

    const res = await brain.reindexMemories({ rebuildFts: true, hours: 720, limit: 50 });

    expect(res.ok).toBe(true);
    expect(res.ftsRebuilt).toBe(true);
    expect(res.reindexedVectors).toBe(50);
    expect(res.memoryIds).toHaveLength(50);
    expect(vectorIndex.vectors.size).toBe(50);

    // Must have been split across multiple bounded batches, each <= 24,000 chars and <= 16 items
    expect(observedBatches.length).toBeGreaterThan(1);
    for (const batch of observedBatches) {
      expect(batch.count).toBeLessThanOrEqual(16);
      expect(batch.totalChars).toBeLessThanOrEqual(24_000);
      expect(batch.truncateInputs).toBe(true);
    }
  });

  it("adaptively splits embedding batches when Workers AI throws 8007 max context overflow", async () => {
    const state = createMockDurableObjectState();
    const { env, vectorIndex } = createMockEnv();
    const origRun = env.AI.run.bind(env.AI);

    let overflowErrorsThrown = 0;
    env.AI = {
      async run(model: string, input: Record<string, unknown>) {
        if (model === "@cf/baai/bge-m3" && Array.isArray(input.text)) {
          const texts = input.text as string[];
          if (texts.length > 2) {
            overflowErrorsThrown++;
            throw new Error("8007: Max context reached 63550 tokens but model supports only 60000");
          }
        }
        return origRun(model as never, input as never);
      }
    } as unknown as typeof env.AI;

    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    for (let i = 0; i < 5; i++) {
      state.sql.exec(
        `INSERT INTO memories (id, namespace, memory_type, title, content, summary, token_count)
         VALUES (?1, 'global', 'semantic', ?2, ?3, 'summary', 200)`,
        `mem-retry-${i}`,
        `Retry Memory #${i}`,
        `Dense token payload #${i} `.repeat(30)
      );
    }

    const res = await brain.reindexMemories({ rebuildFts: false, hours: 720, limit: 10 });

    expect(res.ok).toBe(true);
    expect(res.ftsRebuilt).toBe(false);
    expect(res.reindexedVectors).toBe(5);
    expect(overflowErrorsThrown).toBeGreaterThan(0);
    expect(vectorIndex.vectors.size).toBe(5);
  });

  it("purges targeted gemini-web-oauth tool_call episodic logs while preserving other events", async () => {
    const state = createMockDurableObjectState();
    const { env } = createMockEnv();
    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "tools/call", toolName: "hybrid_recall", status: 200 })
    });
    await brain.logEpisodicEvent({
      sessionId: "brain-stateless-session",
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      payload: JSON.stringify({ rpcMethod: "tools/call", toolName: "get_overnight_diff", status: 200 })
    });
    await brain.logEpisodicEvent({
      sessionId: "oauth-diag",
      clientId: "gemini-web-oauth-diag",
      eventType: "observation",
      payload: JSON.stringify({ route: "/token", status: 400 })
    });
    await brain.logEpisodicEvent({
      sessionId: "sess-real",
      clientId: "antigravity-win11",
      eventType: "checkpoint",
      payload: "Substantive engineering checkpoint."
    });

    // Guardrail: reject unfiltered purge
    await expect(brain.purgeEpisodicLogs({})).rejects.toThrow(/requires at least one/i);

    // Dry run reports exact matches without deleting
    const dry = await brain.purgeEpisodicLogs({
      clientId: "gemini-web-oauth",
      eventType: "tool_call",
      dryRun: true
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.matchedCount).toBe(2);
    expect(dry.deletedCount).toBe(0);
    expect(dry.remainingTotal).toBe(4);

    // Execute purge
    const purged = await brain.purgeEpisodicLogs({
      clientId: "gemini-web-oauth",
      eventType: "tool_call"
    });
    expect(purged.ok).toBe(true);
    expect(purged.dryRun).toBe(false);
    expect(purged.matchedCount).toBe(2);
    expect(purged.deletedCount).toBe(2);
    expect(purged.remainingTotal).toBe(2);
    expect(purged.remainingPending).toBe(2);

    const remainingClients = state.sql
      .exec<{ client_id: string }>(`SELECT client_id FROM episodic_logs ORDER BY log_id ASC`)
      .toArray()
      .map((r) => r.client_id);
    expect(remainingClients).toEqual(["gemini-web-oauth-diag", "antigravity-win11"]);
  });

  it("scans and replaces text across memories, KG entities/edges, decisions, episodic logs, and reindexes vectors", async () => {
    const state = createMockDurableObjectState();
    const { env, vectorIndex } = createMockEnv();
    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    await brain.rememberFact({
      id: "mem-rename-1",
      namespace: "minkalab.net",
      title: "MinkaLab / AyniLab / PulpoLab Architecture",
      content: "Originally known as La Paz Open Lab Project and PulpoLab.",
      triples: [
        {
          subjectId: "doc:arch",
          subjectName: "Architecture Doc",
          relation: "LINKS_TO",
          objectId: "concept:pulpolab",
          objectName: "PulpoLab"
        },
        {
          subjectId: "doc:arch",
          subjectName: "Architecture Doc",
          relation: "LINKS_TO",
          objectId: "concept:minkalab",
          objectName: "MinkaLab"
        }
      ]
    });

    await brain.logDecision({
      namespace: "minkalab.net",
      title: "Rename PulpoLab",
      decision: "Use MinkaLab instead of PulpoLab.",
      rationale: "Canonical project name."
    });

    await brain.logEpisodicEvent({
      sessionId: "sess-rename",
      clientId: "antigravity-win11",
      eventType: "checkpoint",
      payload: "Reviewed AyniLab and LPOLP notes."
    });

    const rules = [
      { pattern: "MinkaLab\\s*/\\s*AyniLab\\s*/\\s*PulpoLab", flags: "gi", replacement: "MinkaLab" },
      { pattern: "La\\s+Paz\\s+Open\\s+Lab\\s+Project", flags: "gi", replacement: "MinkaLab" },
      { pattern: "\\b(?:AyniLab|PulpoLab|LPOLP)\\b", flags: "gi", replacement: "MinkaLab" }
    ];

    // 1. Dry run reports matches without mutating state
    const dry = await brain.replaceTextAcrossLayers({ rules, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.tables.memories.matchedRows).toBe(1);
    expect(dry.tables.memories.updatedRows).toBe(0);
    expect(dry.tables.entities.matchedRows).toBe(1);
    expect(dry.tables.edges.matchedRows).toBe(1);
    expect(dry.tables.decisions.matchedRows).toBe(1);
    expect(dry.tables.episodic_logs.matchedRows).toBe(1);
    expect(dry.reindexedVectors).toBe(0);

    // 2. Live execution updates all layers, merges concept:pulpolab -> concept:minkalab, and reindexes Vectorize
    const applied = await brain.replaceTextAcrossLayers({ rules, dryRun: false });
    expect(applied.ok).toBe(true);
    expect(applied.dryRun).toBe(false);
    expect(applied.tables.memories.updatedRows).toBe(1);
    expect(applied.tables.entities.updatedRows).toBe(1);
    expect(applied.tables.edges.updatedRows).toBe(1);
    expect(applied.tables.decisions.updatedRows).toBe(1);
    expect(applied.tables.episodic_logs.updatedRows).toBe(1);
    expect(applied.ftsRebuilt).toBe(true);
    expect(applied.reindexedVectors).toBe(1);

    const updatedMem = state.sql
      .exec<{ title: string; content: string }>(`SELECT title, content FROM memories WHERE id = 'mem-rename-1'`)
      .one();
    expect(updatedMem.title).toBe("MinkaLab Architecture");
    expect(updatedMem.content).toBe("Originally known as MinkaLab and MinkaLab.");

    const oldEntityCount = state.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM entities WHERE entity_id = 'concept:pulpolab'`)
      .one().cnt;
    expect(oldEntityCount).toBe(0);

    const mergedEdges = state.sql
      .exec<{ edge_id: string }>(`SELECT edge_id FROM edges WHERE source_entity = 'doc:arch'`)
      .toArray()
      .map((e) => e.edge_id);
    expect(mergedEdges).toEqual(["doc:arch|LINKS_TO|concept:minkalab"]);

    expect(vectorIndex.vectors.get("mem-rename-1")?.metadata?.title).toBe("MinkaLab Architecture");
  });

  it("purges targeted decisions, non-protected KG entities/edges, and episodic logs while protecting rpi5", async () => {
    const state = createMockDurableObjectState();
    const { env } = createMockEnv();
    const brain = new BrainMemoryDO(state as unknown as DurableObjectState, env);
    await state.waitUntilReady();

    const dec = await brain.logDecision({
      namespace: "homelab",
      title: "Dropped Project ADR",
      decision: "Temporary test decision",
      rationale: "Testing purgeRecords"
    });
    await brain.rememberFact({
      id: "mem-purge-test",
      namespace: "homelab",
      title: "Temp Entity",
      content: "Temp entity link",
      triples: [
        {
          subjectId: "service:dropped-worker",
          subjectName: "Dropped Worker",
          relation: "STORES_IN",
          objectId: "node:rpi5",
          objectName: "Raspberry Pi 5"
        }
      ]
    });
    const ep = await brain.logEpisodicEvent({
      sessionId: "sess-purge",
      clientId: "antigravity-win11",
      eventType: "checkpoint",
      payload: "Dropped project checkpoint"
    });

    const res = await brain.purgeRecords({
      decisionIds: [dec.decisionId],
      entityIds: ["service:dropped-worker", "node:rpi5"],
      episodicLogIds: [ep.logId]
    });
    expect(res.ok).toBe(true);
    expect(res.deletedDecisions).toBe(1);
    expect(res.deletedEntities).toBe(1);
    expect(res.deletedEdges).toBe(1);
    expect(res.deletedEpisodicLogs).toBe(1);
    expect(res.skippedProtectedEntities).toEqual(["node:rpi5"]);
  });
});
