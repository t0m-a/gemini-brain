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
});
