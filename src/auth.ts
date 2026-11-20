/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\auth.ts
 * Purpose: Constant-time authentication, HMAC-SHA256 OAuth token signing/verification,
 *          redirect_uri allowlisting, PKCE (RFC 7636) verification, and Cloudflare
 *          Access OIDC JWT/JWKS validation helpers.
 */

export function normalizeBearerToken(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^MCP_BEARER_TOKEN\s*=\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

export function toBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return decodeURIComponent(escape(atob(b64 + pad)));
}

export function base64UrlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const raw = atob(b64 + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time string comparison using SHA-256 digests and XOR accumulation,
 * eliminating both timing and length side-channels across Workers and Node runtimes.
 */
export async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
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

export async function createSignedToken(
  prefix: string,
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  if (!secret) {
    throw new Error("Signing secret is required");
  }
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, secret);
  return `${prefix}.${payloadB64}.${sig}`;
}

export async function verifySignedToken<T extends { exp?: number }>(
  token: string,
  expectedPrefix: string,
  secret: string
): Promise<T | null> {
  if (!token || !secret || !token.startsWith(`${expectedPrefix}.`)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = await hmacSign(payloadB64, secret);
  if (!(await timingSafeStringEqual(sig, expectedSig))) return null;

  try {
    const decoded = JSON.parse(fromBase64Url(payloadB64)) as T;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof decoded.exp === "number" && decoded.exp < nowSec) return null;
    return decoded;
  } catch {
    return null;
  }
}

const DEFAULT_ALLOWED_HTTPS_HOSTS = [
  "gemini.google.com",
  "aistudio.google.com",
  "accounts.google.com"
];

const DEFAULT_ALLOWED_HTTPS_SUFFIXES = [
  ".google.com",
  ".googleusercontent.com",
  ".googleapis.com"
];

/**
 * Validates OAuth redirect_uri values against a strict allowlist:
 *  - Same origin as brainOrigin (e.g., https://brain.tsimon.me)
 *  - HTTPS Google / Gemini Web App callback hosts
 *  - RFC 8252 loopback URIs (http://localhost, http://127.0.0.1, http://[::1])
 *  - Optional extra comma-separated origins/hosts via OAUTH_ALLOWED_REDIRECT_ORIGINS
 */
export function isAllowedRedirectUri(
  rawUri: string,
  brainOrigin: string,
  extraAllowedCsv?: string
): boolean {
  if (!rawUri || rawUri.length > 2048) return false;

  let parsed: URL;
  let brainUrl: URL;
  try {
    parsed = new URL(rawUri);
    brainUrl = new URL(brainOrigin);
  } catch {
    return false;
  }

  // RFC 6749 §3.1.2: forbid fragments and embedded credentials
  if (parsed.hash || parsed.username || parsed.password) {
    return false;
  }

  // 1. Same origin as this Brain server
  if (parsed.origin === brainUrl.origin && parsed.protocol === "https:") {
    return true;
  }

  const host = parsed.hostname.toLowerCase();

  // 2. RFC 8252 §7.3 loopback redirect URIs for native/CLI MCP clients
  if (
    parsed.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")
  ) {
    return true;
  }

  // 3. Built-in HTTPS Google / Gemini OAuth callbacks
  if (parsed.protocol === "https:") {
    if (DEFAULT_ALLOWED_HTTPS_HOSTS.includes(host)) {
      return true;
    }
    if (DEFAULT_ALLOWED_HTTPS_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return true;
    }
  }

  // 4. Operator-configured extra allowed origins or hostnames
  if (extraAllowedCsv) {
    const extras = extraAllowedCsv
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of extras) {
      if (entry.startsWith("http://") || entry.startsWith("https://")) {
        try {
          const allowedUrl = new URL(entry);
          if (parsed.origin === allowedUrl.origin) {
            return true;
          }
        } catch {
          continue;
        }
      } else if (parsed.protocol === "https:") {
        const normEntry = entry.toLowerCase();
        if (normEntry.startsWith("*.")) {
          const suffix = normEntry.slice(1);
          if (host.endsWith(suffix) && host.length > suffix.length) {
            return true;
          }
        } else if (host === normEntry) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Verifies RFC 7636 PKCE code_verifier against a previously stored code_challenge.
 * Enforces mandatory verification whenever a code_challenge was supplied at /authorize.
 */
export async function verifyPkceChallenge(
  codeVerifier: string,
  codeChallenge: string | undefined,
  method = "S256"
): Promise<boolean> {
  if (!codeChallenge) return true;
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const normalizedMethod = (method || "S256").toUpperCase();
  if (normalizedMethod === "S256") {
    const hashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier)
    );
    const computedChallenge = uint8ArrayToBase64Url(new Uint8Array(hashBuf));
    return timingSafeStringEqual(computedChallenge, codeChallenge);
  }
  if (normalizedMethod === "PLAIN") {
    return timingSafeStringEqual(codeVerifier, codeChallenge);
  }
  return false;
}

/**
 * Extracts client_id and client_secret from an HTTP Basic Authorization header
 * (per RFC 6749 §2.3.1, URL-decoding components when applicable).
 */
export function extractBasicAuthCredentials(
  authHeader: string | null
): { clientId: string; clientSecret: string } | null {
  if (!authHeader) return null;
  const match = authHeader.trim().match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1].trim());
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) return null;
    const rawId = decoded.slice(0, colonIdx);
    const rawSecret = decoded.slice(colonIdx + 1);
    const safeDecode = (val: string) => {
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    };
    return {
      clientId: safeDecode(rawId),
      clientSecret: safeDecode(rawSecret)
    };
  } catch {
    return null;
  }
}

export interface VerifiedOidcIdentity {
  valid: boolean;
  sub?: string;
  email?: string;
}

export async function verifyCloudflareOidcJwt(
  token: string,
  cfOidcBase: string,
  expectedClientId: string
): Promise<VerifiedOidcIdentity> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };
    const header = JSON.parse(fromBase64Url(parts[0])) as { kid?: string; alg?: string };
    const payload = JSON.parse(fromBase64Url(parts[1])) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      nbf?: number;
      client_id?: string;
      sub?: string;
      email?: string;
    };

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < nowSec) return { valid: false };
    if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return { valid: false };
    if (payload.iss && payload.iss !== cfOidcBase) return { valid: false };

    const audMatch =
      (Array.isArray(payload.aud)
        ? payload.aud.includes(expectedClientId)
        : payload.aud === expectedClientId) ||
      payload.client_id === expectedClientId;
    if (!audMatch) return { valid: false };

    const jwksRes = await fetch(`${cfOidcBase}/jwks`);
    if (!jwksRes.ok) return { valid: false };
    const jwks = (await jwksRes.json()) as {
      keys?: Array<JsonWebKey & { kid?: string; alg?: string }>;
    };
    const keys = jwks.keys || [];
    const matchingKey = header.kid
      ? keys.find((k) => k.kid === header.kid)
      : keys[0];
    if (!matchingKey) return { valid: false };

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      matchingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToUint8Array(parts[2]);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      data
    );
    if (!verified) return { valid: false };
    return {
      valid: true,
      sub: payload.sub,
      email: payload.email
    };
  } catch {
    return { valid: false };
  }
}

export async function verifyCloudflareOidcToken(
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
  const cache = typeof caches !== "undefined" ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return true;
  }

  // 1. Try local cryptographic RS256 verification against Cloudflare Access JWKS
  const jwtCheck = await verifyCloudflareOidcJwt(token, cfOidcBase, expectedClientId);
  if (jwtCheck.valid) {
    if (cache) {
      await cache.put(
        cacheKey,
        new Response("ok", { headers: { "Cache-Control": "max-age=300" } })
      );
    }
    return true;
  }

  // 2. Fallback: Verify via Cloudflare OIDC userinfo endpoint
  try {
    const res = await fetch(`${cfOidcBase}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      if (cache) {
        await cache.put(
          cacheKey,
          new Response("ok", { headers: { "Cache-Control": "max-age=300" } })
        );
      }
      return true;
    }
  } catch {
    // Ignore network errors and fail closed
  }

  return false;
}
