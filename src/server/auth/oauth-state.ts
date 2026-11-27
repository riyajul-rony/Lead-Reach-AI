import crypto from "crypto";

export const OAUTH_STATE_COOKIE = "leadreach_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

function getOAuthStateSecret(): string {
  const secret =
    process.env.AUTH_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.APP_ENCRYPTION_KEY;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET or SESSION_SECRET must be set in production");
  }
  return "leadreach-dev-oauth-state-secret";
}

/**
 * Restricts returnTo to safe, relative app paths starting with a single slash.
 */
export function sanitizeReturnTo(raw: unknown, fallback = "/app"): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return fallback;
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return fallback;
  if (/[\r\n\0\\]/.test(trimmed)) return fallback;

  try {
    const parsed = new URL(trimmed, "http://localhost");
    if (parsed.origin !== "http://localhost") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export interface OAuthStatePayload {
  mode: string;
  userId?: string;
  returnTo: string;
  nonce: string;
  exp: number;
}

export function createOAuthState(input: {
  mode: string;
  userId?: string;
  returnTo: string;
}): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(24).toString("hex");
  const payload: OAuthStatePayload = {
    mode: input.mode,
    ...(input.userId ? { userId: input.userId } : {}),
    returnTo: sanitizeReturnTo(input.returnTo),
    nonce,
    exp: Date.now() + STATE_TTL_MS,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", getOAuthStateSecret())
    .update(payloadB64)
    .digest("base64url");

  return {
    state: `${payloadB64}.${sig}`,
    nonce,
  };
}

export function verifyOAuthState(
  stateRaw: string | null | undefined,
  cookieNonce: string | undefined
): { valid: boolean; mode?: string; userId?: string; returnTo?: string; error?: string } {
  if (!stateRaw || !cookieNonce) {
    return { valid: false, error: "missing_state_or_cookie" };
  }

  const parts = stateRaw.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "malformed_state" };
  }

  const [payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac("sha256", getOAuthStateSecret())
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(sigB64);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: "invalid_signature" };
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as OAuthStatePayload;
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) {
      return { valid: false, error: "expired_state" };
    }
    if (typeof parsed.nonce !== "string" || !parsed.nonce) {
      return { valid: false, error: "missing_nonce" };
    }

    const nonceBuf = Buffer.from(parsed.nonce);
    const cookieBuf = Buffer.from(cookieNonce);
    if (nonceBuf.length !== cookieBuf.length || !crypto.timingSafeEqual(nonceBuf, cookieBuf)) {
      return { valid: false, error: "nonce_mismatch" };
    }

    return {
      valid: true,
      mode: parsed.mode,
      userId: parsed.userId,
      returnTo: sanitizeReturnTo(parsed.returnTo),
    };
  } catch {
    return { valid: false, error: "invalid_payload" };
  }
}
