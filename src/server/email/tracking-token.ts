import crypto from "node:crypto";

function getTrackingSecret(): string {
  return (
    process.env.TRACKING_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.APP_ENCRYPTION_KEY ||
    "leadreach_click_tracking_secret"
  );
}

/**
 * Creates an HMAC-signed tamper-proof click tracking token containing
 * the recipient's unsubscribe token and destination URL.
 * Format: <base64urlPayload>.<base64urlHmac>
 */
export function createSignedTrackingToken(recipientToken: string, targetUrl: string): string {
  const secret = getTrackingSecret();
  const payloadStr = JSON.stringify({ r: recipientToken, u: targetUrl.trim() });
  const payloadB64 = Buffer.from(payloadStr, "utf8").toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${hmac}`;
}

/**
 * Cryptographically verifies an HMAC-signed click tracking token.
 * Returns null if the token is tampered, malformed, or missing required fields.
 */
export function verifySignedTrackingToken(
  signedToken: string
): { recipientToken: string; targetUrl: string } | null {
  if (!signedToken || typeof signedToken !== "string") return null;

  const dotIdx = signedToken.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === signedToken.length - 1) return null;

  const payloadB64 = signedToken.slice(0, dotIdx);
  const signature = signedToken.slice(dotIdx + 1);

  const secret = getTrackingSecret();
  const expectedHmac = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedHmac);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const raw = Buffer.from(payloadB64, "base64url").toString("utf8");
    const data = JSON.parse(raw);
    if (!data.r || !data.u || typeof data.u !== "string") {
      return null;
    }
    return {
      recipientToken: String(data.r).trim(),
      targetUrl: String(data.u).trim(),
    };
  } catch {
    return null;
  }
}
