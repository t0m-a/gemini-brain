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
    expect(card.tools).toContain("hybrid_recall");

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
});
