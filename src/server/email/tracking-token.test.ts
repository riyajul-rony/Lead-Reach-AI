import { describe, it, expect } from "vitest";
import { createSignedTrackingToken, verifySignedTrackingToken } from "./tracking-token";
import { buildEmailMultipartBodies } from "./sending-engine";

describe("HIGH-02: Secure Click Tracking & Link Wrapping", () => {
  const sampleUnsubToken = "unsub_token_abc_123";
  const destinationUrl = "https://example.com/pricing?ref=leadreach";

  it("creates and verifies a valid HMAC-signed click tracking token", () => {
    const signed = createSignedTrackingToken(sampleUnsubToken, destinationUrl);
    expect(signed).toContain(".");

    const verified = verifySignedTrackingToken(signed);
    expect(verified).not.toBeNull();
    expect(verified?.recipientToken).toBe(sampleUnsubToken);
    expect(verified?.targetUrl).toBe(destinationUrl);
  });

  it("rejects tampered or forged tokens (fails closed)", () => {
    const signed = createSignedTrackingToken(sampleUnsubToken, destinationUrl);
    const [payload, sig] = signed.split(".");

    // Tamper with payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({ r: sampleUnsubToken, u: "https://evil-phishing.com" })
    ).toString("base64url");
    const tamperedToken = `${tamperedPayload}.${sig}`;

    expect(verifySignedTrackingToken(tamperedToken)).toBeNull();

    // Tamper with signature
    const badSigToken = `${payload}.${sig.slice(0, -4)}xxxx`;
    expect(verifySignedTrackingToken(badSigToken)).toBeNull();

    // Empty or non-dot tokens
    expect(verifySignedTrackingToken("invalid_token")).toBeNull();
    expect(verifySignedTrackingToken("")).toBeNull();
  });

  it("wraps links in HTML when trackingClick=true, but keeps plain text unwrapped", () => {
    const bodies = buildEmailMultipartBodies({
      bodyText: "Check out our services at https://example.com/demo and read more at https://example.com/about",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: true,
    });

    // Plaintext has raw URLs and NO tracking tokens
    expect(bodies.text).toContain("https://example.com/demo");
    expect(bodies.text).not.toContain("/api/v1/track/click/");

    // HTML wraps destination with secure click tracking (no injected footer)
    expect(bodies.html).toContain("/api/v1/track/click/");
    expect(bodies.html).toContain("https://example.com/demo");
  });

  it("omits HTML wrapper and leaves links unwrapped when trackingOpen=false and trackingClick=false", () => {
    const bodies = buildEmailMultipartBodies({
      bodyText: "Visit https://example.com/demo",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: false,
    });

    // Plain-text template with tracking disabled emits text/plain only
    expect(bodies.html).toBeUndefined();
    expect(bodies.text).toBe("Visit https://example.com/demo");
  });

  it("omits click tracking links and pixel on HTML templates when tracking toggles are false", () => {
    const bodies = buildEmailMultipartBodies({
      bodyText: "<p>Visit https://example.com/demo</p>",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: false,
    });

    expect(bodies.html).not.toContain("/api/v1/track/click/");
    expect(bodies.html).not.toContain("/api/v1/track/open/");
  });

  it("never wraps unsubscribe links inside the body", () => {
    const unsubUrl = "http://localhost:3000/api/v1/unsubscribe/token_123";
    const bodies = buildEmailMultipartBodies({
      bodyText: `If you wish to stop emails, click ${unsubUrl}`,
      legalAddress: "123 Business St, City",
      unsubscribeUrl: unsubUrl,
      unsubscribeToken: "token_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: true,
    });

    // The unsubUrl in the body must NOT be wrapped with click tracking
    expect(bodies.html).toContain(`href="${unsubUrl}"`);
    expect(bodies.html).not.toContain(`/api/v1/track/click/`);
  });

  it("never wraps mailto:, tel:, or #anchor links", () => {
    const bodies = buildEmailMultipartBodies({
      bodyText: "Contact me at mailto:hello@leadreach.ai or call tel:+123456789 or jump to #section",
      legalAddress: "123 Business St, City",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: true,
    });

    // None of mailto, tel, or anchor links should be wrapped by track/click
    expect(bodies.html).not.toContain("/api/v1/track/click/");
    expect(bodies.html).toContain("mailto:hello@leadreach.ai");
    expect(bodies.html).toContain("tel:+123456789");
    expect(bodies.html).toContain("#section");
  });

  it("rewrites only HTML href attribute while keeping visible anchor text and plain-text part unchanged, and uses TRACKING_SECRET when set", () => {
    const prevTracking = process.env.TRACKING_SECRET;
    const prevAuth = process.env.AUTH_SECRET;
    try {
      process.env.AUTH_SECRET = "auth_secret_32_chars_long_12345678";
      process.env.TRACKING_SECRET = "dedicated_tracking_secret_value_1";

      const target = "https://example.com/offer";
      const tokenWithDedicated = createSignedTrackingToken("tok_1", target);

      const bodies = buildEmailMultipartBodies({
        bodyText: `Visit ${target} or unsubscribe at http://localhost:3000/u/tok_1`,
        legalAddress: "123 Business St",
        unsubscribeUrl: "http://localhost:3000/u/tok_1",
        unsubscribeToken: "tok_1",
        baseUrl: "http://localhost:3000",
        trackingOpen: false,
        trackingClick: true,
      });

      // Plain-text part has raw URL untouched
      expect(bodies.text).toContain(`Visit ${target}`);
      expect(bodies.text).not.toContain("/api/v1/track/click/");

      // HTML href uses signed tracking URL, while visible anchor text remains raw URL
      expect(bodies.html).toContain(`href="http://localhost:3000/api/v1/track/click/${tokenWithDedicated}"`);
      expect(bodies.html).toContain(`>${target}</a>`);

      // /u/<token> unsubscribe link is untouched in both body and footer
      expect(bodies.html).toContain('href="http://localhost:3000/u/tok_1"');

      // Rotating AUTH_SECRET does not break tokens signed with TRACKING_SECRET
      process.env.AUTH_SECRET = "rotated_auth_secret_32_chars_long_99";
      const verified = verifySignedTrackingToken(tokenWithDedicated);
      expect(verified?.targetUrl).toBe(target);
      expect(verified?.recipientToken).toBe("tok_1");
    } finally {
      if (prevTracking === undefined) delete process.env.TRACKING_SECRET;
      else process.env.TRACKING_SECRET = prevTracking;
      if (prevAuth === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = prevAuth;
    }
  });
});
