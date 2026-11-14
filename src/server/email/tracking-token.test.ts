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
      legalAddress: "123 Business St, City",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: true,
    });

    // Plaintext has raw URLs and NO tracking tokens
    expect(bodies.text).toContain("https://example.com/demo");
    expect(bodies.text).not.toContain("/api/v1/track/click/");

    // HTML wraps destination with secure click tracking
    expect(bodies.html).toContain("/api/v1/track/click/");
    expect(bodies.html).toContain("https://example.com/demo");

    // Unsubscribe link in footer is never wrapped with click tracking
    expect(bodies.html).toContain('href="http://localhost:3000/api/v1/unsubscribe/unsub_123"');
    expect(bodies.html).not.toContain("/api/v1/track/click/?url=http://localhost:3000/api/v1/unsubscribe");
  });

  it("leaves links unwrapped when trackingClick=false", () => {
    const bodies = buildEmailMultipartBodies({
      bodyText: "Visit https://example.com/demo",
      legalAddress: "123 Business St, City",
      unsubscribeUrl: "http://localhost:3000/api/v1/unsubscribe/unsub_123",
      unsubscribeToken: "unsub_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: false,
    });

    // No tracking click endpoint anywhere in HTML or text
    expect(bodies.html).not.toContain("/api/v1/track/click/");
    expect(bodies.html).toContain('href="https://example.com/demo"');
    expect(bodies.text).toContain("https://example.com/demo");
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
});
