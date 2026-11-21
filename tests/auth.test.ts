import { describe, it, expect, vi, afterEach } from "vitest";
import pkg from "../package.json";
import { BRAIN_VERSION } from "../src/version";
import {
  createSignedToken,
  extractBasicAuthCredentials,
  isAllowedRedirectUri,
  normalizeBearerToken,
  timingSafeStringEqual,
  uint8ArrayToBase64Url,
  verifyPkceChallenge,
  verifySignedToken
} from "../src/auth";
import worker from "../src/index";
import { createMockEnv } from "./mocks/do-sqlite-adapter";

const BRAIN_ORIGIN = "https://brain.tsimon.me";
const TEST_SECRET = "test-bearer-token-64-chars-minimum-entropy-for-unit-tests-000001";

function createExecCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {}
  } as unknown as ExecutionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Version single source of truth", () => {
  it("BRAIN_VERSION matches package.json version", () => {
    expect(BRAIN_VERSION).toBe(pkg.version);
    expect(BRAIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("src/auth.ts primitives", () => {
  it("normalizes raw bearer headers and .dev.vars paste formats", () => {
    expect(normalizeBearerToken('MCP_BEARER_TOKEN="abc123"')).toBe("abc123");
    expect(normalizeBearerToken("Bearer   xyz789  ")).toBe("xyz789");
    expect(normalizeBearerToken("  'tok_1'  ")).toBe("tok_1");
    expect(normalizeBearerToken(null)).toBe("");
  });

  it("compares strings in constant time via SHA-256 digest XOR", async () => {
    expect(await timingSafeStringEqual("alpha-123", "alpha-123")).toBe(true);
    expect(await timingSafeStringEqual("alpha-123", "alpha-124")).toBe(false);
    expect(await timingSafeStringEqual("short", "much-longer-value")).toBe(false);
  });

  it("enforces strict redirect_uri allowlist", () => {
    expect(isAllowedRedirectUri("https://brain.tsimon.me/callback", BRAIN_ORIGIN)).toBe(true);
    expect(isAllowedRedirectUri("https://gemini.google.com/mcp/oauth/callback", BRAIN_ORIGIN)).toBe(true);
    expect(isAllowedRedirectUri("https://aistudio.google.com/callback", BRAIN_ORIGIN)).toBe(true);
    expect(isAllowedRedirectUri("https://app.googleusercontent.com/cb", BRAIN_ORIGIN)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:41234/cb", BRAIN_ORIGIN)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8787/cb", BRAIN_ORIGIN)).toBe(true);
    expect(
      isAllowedRedirectUri("https://claude.ai/api/mcp/callback", BRAIN_ORIGIN, "https://claude.ai")
    ).toBe(true);
    expect(
      isAllowedRedirectUri("https://sub.custom.dev/cb", BRAIN_ORIGIN, "*.custom.dev")
    ).toBe(true);

    // Disallowed open redirects, scheme downgrades, credential injection, and fragments
    expect(isAllowedRedirectUri("https://evil.example/steal", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("https://gemini.google.com.evil.example/cb", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("http://gemini.google.com/cb", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("https://user:pass@gemini.google.com/cb", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("https://gemini.google.com/cb#frag", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)", BRAIN_ORIGIN)).toBe(false);
    expect(isAllowedRedirectUri("", BRAIN_ORIGIN)).toBe(false);
  });

  it("enforces mandatory RFC 7636 PKCE when code_challenge is present", async () => {
    const verifier = "pkce-verifier-with-more-than-43-characters-entropy-012345";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = uint8ArrayToBase64Url(new Uint8Array(digest));

    expect(await verifyPkceChallenge(verifier, challenge, "S256")).toBe(true);
    expect(await verifyPkceChallenge("", challenge, "S256")).toBe(false);
    expect(await verifyPkceChallenge("wrong-verifier-with-43-plus-characters-entropy-012345", challenge, "S256")).toBe(false);
    expect(await verifyPkceChallenge("too-short", challenge, "S256")).toBe(false);
    expect(await verifyPkceChallenge("", undefined, "S256")).toBe(true);
  });

  it("rejects tampered, wrong-prefix, expired, or unsigned tokens", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tok = await createSignedToken("bcode", { cf: "abc", exp: nowSec + 60 }, TEST_SECRET);
    expect((await verifySignedToken<{ cf: string }>(tok, "bcode", TEST_SECRET))?.cf).toBe("abc");
    expect(await verifySignedToken(tok, "bat", TEST_SECRET)).toBeNull();
    expect(await verifySignedToken(`${tok}tamper`, "bcode", TEST_SECRET)).toBeNull();
    expect(await verifySignedToken(tok, "bcode", "")).toBeNull();

    const expired = await createSignedToken("bcode", { cf: "abc", exp: nowSec - 5 }, TEST_SECRET);
    expect(await verifySignedToken(expired, "bcode", TEST_SECRET)).toBeNull();
  });

  it("parses HTTP Basic Auth headers including colons inside client_secret", () => {
    const hdr = `Basic ${btoa("cid_123:part1:part2:part3")}`;
    expect(extractBasicAuthCredentials(hdr)).toEqual({
      clientId: "cid_123",
      clientSecret: "part1:part2:part3"
    });
    expect(extractBasicAuthCredentials("Bearer abc")).toBeNull();
  });
});

describe("Worker HTTP auth & OAuth 2.1 boundary enforcement (src/index.ts)", () => {
  it("fails closed with 503 when MCP_BEARER_TOKEN is missing", async () => {
    const { env } = createMockEnv({ MCP_BEARER_TOKEN: "" });

    const mcpRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      }),
      env,
      createExecCtx()
    );
    expect(mcpRes.status).toBe(503);

    const authRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/authorize?redirect_uri=${encodeURIComponent("https://gemini.google.com/cb")}`),
      env,
      createExecCtx()
    );
    expect(authRes.status).toBe(503);

    const nocRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp?noc=dashboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }),
      env,
      createExecCtx()
    );
    expect(nocRes.status).toBe(503);
  });

  it("exposes unified package.json version on /server-card and /mcp?ui=1", async () => {
    const { env } = createMockEnv();

    const cardRes = await worker.fetch(new Request(`${BRAIN_ORIGIN}/server-card`), env, createExecCtx());
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as { version: string; tools: string[] };
    expect(card.version).toBe(BRAIN_VERSION);
    expect(card.tools).toHaveLength(9);
    expect(card.tools).toContain("forget_memory");
    expect(card.tools).toContain("hybrid_recall");
    expect(card.tools).toContain("record_outcome");
    expect(card.tools).toContain("validate_memory");
    // ADR-02 invariant: MCP tools must remain in strict alphabetical order
    expect(card.tools).toEqual([...card.tools].sort());

    const uiRes = await worker.fetch(new Request(`${BRAIN_ORIGIN}/mcp?ui=1`), env, createExecCtx());
    expect(uiRes.status).toBe(200);
    expect(await uiRes.text()).toContain(`v${BRAIN_VERSION}`);
  });

  it("rejects unauthenticated POST /mcp with 401 and WWW-Authenticate metadata", async () => {
    const { env } = createMockEnv();
    const res = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      }),
      env,
      createExecCtx()
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
  });

  it("rejects disallowed redirect_uri in /authorize and /register", async () => {
    const { env } = createMockEnv();

    const authRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/authorize?redirect_uri=${encodeURIComponent("https://evil.example/cb")}`),
      env,
      createExecCtx()
    );
    expect(authRes.status).toBe(400);

    const regRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] })
      }),
      env,
      createExecCtx()
    );
    expect(regRes.status).toBe(400);
  });

  it("blocks forged /callback -> /token OAuth bypass when Cloudflare Access rejects code", async () => {
    const { env } = createMockEnv();

    const verifier = "end-to-end-test-pkce-verifier-with-48-plus-characters-ok";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = uint8ArrayToBase64Url(new Uint8Array(digest));

    // Step 1: /authorize
    const authRes = await worker.fetch(
      new Request(
        `${BRAIN_ORIGIN}/authorize?redirect_uri=${encodeURIComponent("https://gemini.google.com/mcp/cb")}&state=s1&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`
      ),
      env,
      createExecCtx()
    );
    expect(authRes.status).toBe(302);
    const bstate = new URL(authRes.headers.get("location")!).searchParams.get("state")!;
    expect(bstate.startsWith("bstate.")).toBe(true);

    // Step 2: /callback with forged code
    const cbRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/callback?code=FORGED_CODE&state=${encodeURIComponent(bstate)}`),
      env,
      createExecCtx()
    );
    expect(cbRes.status).toBe(302);
    const bcode = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;

    // Step 3a: Missing PKCE verifier -> 400
    const noPkceRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: bcode }).toString()
      }),
      env,
      createExecCtx()
    );
    expect(noPkceRes.status).toBe(400);

    // Step 3b: Valid PKCE + forged cfCode -> mock Cloudflare Access returning 400 invalid_grant
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );

    const forgedRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: bcode,
          code_verifier: verifier,
          redirect_uri: "https://gemini.google.com/mcp/cb"
        }).toString()
      }),
      env,
      createExecCtx()
    );
    expect(forgedRes.status).toBe(400);
    const forgedBody = (await forgedRes.json()) as Record<string, unknown>;
    expect(forgedBody.error).toBe("invalid_grant");
    expect(forgedBody.access_token).toBeUndefined();
  });

  it("mints bat.* and brt.* and rotates refresh tokens only after real upstream RS256 JWKS verification", async () => {
    const { env } = createMockEnv();
    const cfOidcBase = `${env.OAUTH_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.OAUTH_CLIENT_ID}`;

    // Generate a real RS256 keypair to sign a mock Cloudflare Access id_token
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const publicJwk = {
      ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
      kid: "test-cf-kid-1",
      alg: "RS256"
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const encodePart = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    const headerPart = encodePart({ alg: "RS256", typ: "JWT", kid: "test-cf-kid-1" });
    const payloadPart = encodePart({
      iss: cfOidcBase,
      aud: env.OAUTH_CLIENT_ID,
      sub: "user-thomas-verified",
      email: "thomas@tsimon.me",
      iat: nowSec,
      exp: nowSec + 3600
    });
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    );
    const fakeValidIdToken = `${headerPart}.${payloadPart}.${uint8ArrayToBase64Url(new Uint8Array(sigBuf))}`;

    // Build signed bcode.* from valid /authorize + /callback
    const verifier = "legitimate-pkce-verifier-with-more-than-43-characters-entropy";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = uint8ArrayToBase64Url(new Uint8Array(digest));

    const bcode = await createSignedToken(
      "bcode",
      {
        cf: "REAL_CF_CODE_123",
        r: "https://gemini.google.com/mcp/cb",
        cc: challenge,
        ccm: "S256",
        exp: nowSec + 300
      },
      TEST_SECRET
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === `${cfOidcBase}/token`) {
        return Response.json({ access_token: "cf_at", id_token: fakeValidIdToken });
      }
      if (target === `${cfOidcBase}/jwks`) {
        return Response.json({ keys: [publicJwk] });
      }
      throw new Error(`Unexpected upstream fetch in test: ${target}`);
    });

    const tokRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:real-client-secret`)}`
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: bcode,
          code_verifier: verifier,
          redirect_uri: "https://gemini.google.com/mcp/cb"
        }).toString()
      }),
      env,
      createExecCtx()
    );
    expect(tokRes.status).toBe(200);
    const tokJson = (await tokRes.json()) as { access_token: string; refresh_token: string };
    expect(tokJson.access_token.startsWith("bat.")).toBe(true);
    expect(tokJson.refresh_token.startsWith("brt.")).toBe(true);

    // Verify refresh_token rotation works and preserves verified subject
    const rotRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokJson.refresh_token
        }).toString()
      }),
      env,
      createExecCtx()
    );
    expect(rotRes.status).toBe(200);
    const rotJson = (await rotRes.json()) as { access_token: string; refresh_token: string };
    expect(rotJson.access_token.startsWith("bat.")).toBe(true);
    const decodedBat = await verifySignedToken<{ sub: string; email: string }>(
      rotJson.access_token,
      "bat",
      TEST_SECRET
    );
    expect(decodedBat?.sub).toBe("user-thomas-verified");
    expect(decodedBat?.email).toBe("thomas@tsimon.me");
  });

  it("emits Gemini-compatible MCP tools/list JSON Schemas with zero anyOf/oneOf/allOf/const/$ref keywords", async () => {
    const { env } = createMockEnv();
    const res = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TEST_SECRET}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "schema-audit",
          method: "tools/list",
          params: {}
        })
      }),
      env,
      createExecCtx()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const tools = body.result.tools;
    expect(tools).toHaveLength(9);
    // Strict ADR-02 alphabetical tool order
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());

    const forbiddenKeys = new Set(["anyOf", "oneOf", "allOf", "const", "$ref", "not"]);
    const walkKeys = (obj: unknown, path: string, bad: string[]) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => walkKeys(v, `${path}[${i}]`, bad));
        return;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (forbiddenKeys.has(k)) bad.push(`${path}.${k}`);
        walkKeys(v, `${path}.${k}`, bad);
      }
    };

    const violations: string[] = [];
    for (const tool of tools) {
      walkKeys(tool.inputSchema, tool.name, violations);
    }
    expect(violations).toEqual([]);
  });

  it("does not emit automatic gemini-web-oauth tool_call episodic logs for OAuth MCP calls", async () => {
    const loggedEvents: Array<{ clientId?: string; eventType: string; payload: string }> = [];
    const pendingWaits: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil: (p: Promise<unknown>) => {
        pendingWaits.push(p);
      },
      passThroughOnException: () => {},
      props: {}
    } as unknown as ExecutionContext;

    const { env } = createMockEnv();
    env.BRAIN_DO = {
      idFromName: () => "singleton-brain-id",
      get: () => ({
        logEpisodicEvent: async (ev: { clientId?: string; eventType: string; payload: string }) => {
          loggedEvents.push(ev);
          return { logId: loggedEvents.length };
        },
        getOvernightDiff: async () => ({
          hydrationMarkdown: "# Overnight Diff\nNo changes."
        })
      })
    } as unknown as typeof env.BRAIN_DO;

    const bat = await createSignedToken(
      "bat",
      { sub: "user-test", email: "thomas@tsimon.me", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET
    );

    // 1. Handshake RPCs AND tools/call over OAuth must NOT write gemini-web-oauth tool_call episodic logs
    for (const body of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "gemini-web", version: "1.0" }
        }
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_overnight_diff", arguments: { hours: 12 } }
      }
    ]) {
      const r = await worker.fetch(
        new Request(`${BRAIN_ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${bat}`
          },
          body: JSON.stringify(body)
        }),
        env,
        execCtx
      );
      expect(r.status).toBeLessThan(300);
    }
    await Promise.allSettled(pendingWaits);
    expect(loggedEvents).toHaveLength(0);

    // 2. Smoke verifier UA should NOT pollute episodic_logs via logAuthDiag
    const smokeRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/authorize?redirect_uri=${encodeURIComponent("https://evil.example/cb")}`, {
        headers: { "User-Agent": "BrainMCP-Verifier/2.0" }
      }),
      env,
      execCtx
    );
    expect(smokeRes.status).toBe(400);
    await Promise.allSettled(pendingWaits);
    expect(loggedEvents).toHaveLength(0);
  });

  it("routes authenticated NOC purge_episodic action to BRAIN_DO.purgeEpisodicLogs", async () => {
    const purgeCalls: Array<Record<string, unknown>> = [];
    const { env } = createMockEnv();
    env.BRAIN_DO = {
      idFromName: () => "singleton-brain-id",
      get: () => ({
        purgeEpisodicLogs: async (input: Record<string, unknown>) => {
          purgeCalls.push(input);
          return {
            ok: true,
            dryRun: Boolean(input.dryRun),
            matchedCount: 372,
            deletedCount: input.dryRun ? 0 : 372,
            remainingTotal: 107,
            remainingPending: 4,
            filters: {
              clientId: (input.clientId as string) || null,
              eventType: (input.eventType as string) || null,
              consolidatedOnly: Boolean(input.consolidatedOnly)
            }
          };
        }
      })
    } as unknown as typeof env.BRAIN_DO;

    const res = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp?noc=purge_episodic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_SECRET}`,
          "X-Brain-Noc-Action": "purge_episodic"
        },
        body: JSON.stringify({
          clientId: "gemini-web-oauth",
          eventType: "tool_call",
          dryRun: false
        })
      }),
      env,
      createExecCtx()
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; deletedCount: number };
    expect(data.ok).toBe(true);
    expect(data.deletedCount).toBe(372);
    expect(purgeCalls).toEqual([
      {
        clientId: "gemini-web-oauth",
        eventType: "tool_call",
        consolidatedOnly: false,
        dryRun: false
      }
    ]);
  });

  it("propagates X-Brain-Client-Id header as default clientId for MCP writes without filtering get_overnight_diff", async () => {
    const rememberedCalls: Array<{ clientId?: string; title?: string }> = [];
    const episodicCalls: Array<{ clientId?: string; sessionId?: string }> = [];
    const diffCalls: Array<{ clientId?: string; hours?: number }> = [];

    const { env } = createMockEnv();
    env.BRAIN_DO = {
      idFromName: () => "singleton-brain-id",
      get: () => ({
        rememberFact: async (input: { clientId?: string; title?: string }) => {
          rememberedCalls.push(input);
          return { id: "mem-1", mutationId: 1 };
        },
        logEpisodicEvent: async (input: { clientId?: string; sessionId?: string }) => {
          episodicCalls.push(input);
          return { logId: 1 };
        },
        getOvernightDiff: async (input: { clientId?: string; hours?: number }) => {
          diffCalls.push(input);
          return { hydrationMarkdown: "# Overnight Diff\nAll clients." };
        }
      })
    } as unknown as typeof env.BRAIN_DO;

    const callMcp = (body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
      worker.fetch(
        new Request(`${BRAIN_ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${TEST_SECRET}`,
            ...extraHeaders
          },
          body: JSON.stringify(body)
        }),
        env,
        createExecCtx()
      );

    // 1. Omitted clientId on remember_fact falls back to X-Brain-Client-Id header
    const r1 = await callMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "remember_fact",
          arguments: { title: "RPi5 CLI test", content: "Attributed via header." }
        }
      },
      { "X-Brain-Client-Id": "antigravity-cli-rpi5" }
    );
    expect(r1.status).toBe(200);
    expect(rememberedCalls[0]?.clientId).toBe("antigravity-cli-rpi5");

    // 2. Explicit clientId in arguments overrides X-Brain-Client-Id header
    const r2 = await callMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remember_fact",
          arguments: {
            title: "Explicit override",
            content: "Explicit clientId wins.",
            clientId: "antigravity-win11"
          }
        }
      },
      { "X-Brain-Client-Id": "antigravity-cli-rpi5" }
    );
    expect(r2.status).toBe(200);
    expect(rememberedCalls[1]?.clientId).toBe("antigravity-win11");

    // 3. log_episodic_event without clientId falls back to X-Brain-Client-Id header
    const r3 = await callMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "log_episodic_event",
          arguments: {
            sessionId: "rpi5-session-1",
            eventType: "checkpoint",
            payload: "RPi5 CLI session completed."
          }
        }
      },
      { "X-Brain-Client-Id": "antigravity-cli-rpi5" }
    );
    expect(r3.status).toBe(200);
    expect(episodicCalls[0]?.clientId).toBe("antigravity-cli-rpi5");

    // 4. get_overnight_diff does NOT restrict filter to X-Brain-Client-Id
    const r4 = await callMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_overnight_diff", arguments: { hours: 12 } }
      },
      { "X-Brain-Client-Id": "antigravity-cli-rpi5" }
    );
    expect(r4.status).toBe(200);
    expect(diffCalls[0]?.clientId).toBeUndefined();
  });

  it("advertises antigravity-cli-rpi5 on /server-card and Cognitive NOC dashboard", async () => {
    const { env } = createMockEnv();
    const cardRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/server-card`),
      env,
      createExecCtx()
    );
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as {
      client_sources?: Array<{ clientId: string; surface: string; transport: string }>;
    };
    expect(card.client_sources?.some((s) => s.clientId === "antigravity-cli-rpi5")).toBe(true);

    const uiRes = await worker.fetch(
      new Request(`${BRAIN_ORIGIN}/mcp?ui=1`, { headers: { Accept: "text/html" } }),
      env,
      createExecCtx()
    );
    expect(uiRes.status).toBe(200);
    const html = await uiRes.text();
    expect(html).toContain("antigravity-cli-rpi5");
    expect(html).toContain("6 Surfaces");

    const surfaceOrder = [
      "Google Antigravity IDE / 2.0",
      "Raspberry Pi 5 Home Lab (node:rpi5)",
      "Raspberry Pi 5 Gemini CLI",
      "Gemini Web App Bridge",
      "Nocturnal Dreamer (Llama 3.3 70B)",
      "Gemini CLI Terminal (Win11)"
    ];
    const surfaceCardsSection = html.slice(html.indexOf("const surfaceCards = ["));
    const positions = surfaceOrder.map((label) => surfaceCardsSection.indexOf(label));
    positions.forEach((pos) => expect(pos).toBeGreaterThan(-1));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
