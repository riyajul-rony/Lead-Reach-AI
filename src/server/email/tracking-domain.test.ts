import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import {
  createTrackingDomain,
  isValidPublicFqdn,
  normalizeTrackingDomain,
  resolveTrackingBaseUrl,
  verifyTrackingDomainDns,
} from "@/server/email/tracking-domain-service";
import { GET as tlsAskHandler } from "@/app/api/internal/tls-ask/route";
import { proxy } from "@/proxy";

describe("Phase 3 Step 4: Custom Tracking Domain (CTD / CNAME)", () => {
  const prevAppUrl = process.env.APP_URL;
  const prevAppDomain = process.env.APP_DOMAIN;
  const prevNextAuth = process.env.NEXTAUTH_URL;
  const prevCnameTarget = process.env.TRACKING_CNAME_TARGET;
  const prevTlsSecret = process.env.CTD_TLS_ASK_SECRET;

  beforeEach(() => {
    process.env.APP_URL = "https://app.leadreach.test";
    process.env.APP_DOMAIN = "app.leadreach.test";
    process.env.NEXTAUTH_URL = "https://app.leadreach.test";
    process.env.TRACKING_CNAME_TARGET = "cname.leadreach.test";
    delete process.env.CTD_TLS_ASK_SECRET;
  });

  afterEach(() => {
    process.env.APP_URL = prevAppUrl;
    process.env.APP_DOMAIN = prevAppDomain;
    process.env.NEXTAUTH_URL = prevNextAuth;
    process.env.TRACKING_CNAME_TARGET = prevCnameTarget;
    process.env.CTD_TLS_ASK_SECRET = prevTlsSecret;
  });

  it("1. Strictly validates public FQDNs and rejects IPs, wildcards, localhost, and primary APP_DOMAIN", () => {
    expect(isValidPublicFqdn("track.client.com")).toBe(true);
    expect(isValidPublicFqdn("links.sub.agency.io")).toBe(true);

    expect(isValidPublicFqdn("127.0.0.1")).toBe(false);
    expect(isValidPublicFqdn("192.168.1.10")).toBe(false);
    expect(isValidPublicFqdn("*.client.com")).toBe(false);
    expect(isValidPublicFqdn("localhost")).toBe(false);
    expect(isValidPublicFqdn("track.localhost")).toBe(false);
    expect(isValidPublicFqdn("https://track.client.com")).toBe(false);
    expect(isValidPublicFqdn("track.client.com:3000")).toBe(false);

    expect(normalizeTrackingDomain("  TRACK.Client-One.com.  ")).toBe("track.client-one.com");
    expect(() => normalizeTrackingDomain("app.leadreach.test")).toThrow(
      /primary application domain/i
    );
  });

  it("2. Verifies CNAME via DNS lookup and resolves tracking URL only when verified", async () => {
    const userId = `u-ctd-${Date.now()}`;
    const created = await createTrackingDomain(userId, "track.acme-outreach.com");
    expect(created.status).toBe("pending");

    // Before verification, base URL falls back safely to primary APP_URL
    const beforeVerify = await resolveTrackingBaseUrl(userId, created.id);
    expect(beforeVerify).toBe("https://app.leadreach.test");

    // Failed DNS check
    const failed = await verifyTrackingDomainDns(userId, created.id, async () => [
      "wrong.example.org",
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toContain("wrong.example.org");
    expect(await resolveTrackingBaseUrl(userId, created.id)).toBe(
      "https://app.leadreach.test"
    );

    // Matching CNAME check
    const verified = await verifyTrackingDomainDns(userId, created.id, async () => [
      "CNAME.LEADREACH.TEST.",
    ]);
    expect(verified.status).toBe("verified");
    expect(verified.is_default).toBe(true);

    // Now resolves to custom HTTPS tracking domain
    expect(await resolveTrackingBaseUrl(userId, created.id)).toBe(
      "https://track.acme-outreach.com"
    );
    expect(await resolveTrackingBaseUrl(userId)).toBe(
      "https://track.acme-outreach.com"
    );
  });

  it("3. Protects GET /api/internal/tls-ask against public enumeration and non-FQDN probes", async () => {
    const userId = `u-tls-${Date.now()}`;
    const pendingDom = await createTrackingDomain(userId, "pending.agency.io");
    const verifiedDom = await createTrackingDomain(userId, "links.agency.io");
    await db.tracking_domains.update({
      where: { id: verifiedDom.id },
      data: { status: "verified", verified_at: new Date() },
    });

    // Proxied public internet request blocked when no secret is set
    const proxiedReq = new NextRequest(
      "https://app.leadreach.test/api/internal/tls-ask?domain=links.agency.io",
      {
        headers: {
          host: "app.leadreach.test",
          "x-forwarded-for": "203.0.113.9",
        },
      }
    );
    expect((await tlsAskHandler(proxiedReq)).status).toBe(403);

    // Non-FQDN / wildcard probes blocked with 400
    const wildcardReq = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=*.agency.io",
      { headers: { host: "web:3000" } }
    );
    expect((await tlsAskHandler(wildcardReq)).status).toBe(400);

    // Verified domain allowed (200) for internal Caddy call
    const okReq = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=links.agency.io",
      { headers: { host: "web:3000" } }
    );
    expect((await tlsAskHandler(okReq)).status).toBe(200);

    // Pending vs unknown domains both return 403 without leaking existence
    const pendingReq = new NextRequest(
      `http://web:3000/api/internal/tls-ask?domain=${pendingDom.domain}`,
      { headers: { host: "web:3000" } }
    );
    const unknownReq = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=never-added.example.net",
      { headers: { host: "web:3000" } }
    );
    expect((await tlsAskHandler(pendingReq)).status).toBe(403);
    expect((await tlsAskHandler(unknownReq)).status).toBe(403);

    // Shared secret enforcement when CTD_TLS_ASK_SECRET is configured
    process.env.CTD_TLS_ASK_SECRET = "super-secret-tls-ask-token";
    const missingSecret = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=links.agency.io",
      { headers: { host: "web:3000" } }
    );
    expect((await tlsAskHandler(missingSecret)).status).toBe(403);

    const validSecret = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=links.agency.io",
      {
        headers: {
          host: "web:3000",
          "x-tls-ask-secret": "super-secret-tls-ask-token",
        },
      }
    );
    expect((await tlsAskHandler(validSecret)).status).toBe(200);
  });

  it("4. Restricts custom tracking domain hostnames to tracking/unsubscribe routes only (404 elsewhere)", () => {
    const allowedOpen = proxy(
      new NextRequest("https://track.client.com/api/v1/track/open/tok123", {
        headers: { host: "track.client.com" },
      })
    );
    expect(allowedOpen.status).toBe(200);

    const allowedClick = proxy(
      new NextRequest("https://track.client.com/api/v1/track/click/tok123", {
        headers: { host: "track.client.com" },
      })
    );
    expect(allowedClick.status).toBe(200);

    const allowedUnsub = proxy(
      new NextRequest("https://track.client.com/u/tok123", {
        headers: { host: "track.client.com" },
      })
    );
    expect(allowedUnsub.status).toBe(200);

    // Admin, login, app routes must return 404 on custom tracking domains
    for (const blockedPath of [
      "/",
      "/login",
      "/app/outreach",
      "/admin",
      "/api/v1/admin/users",
      "/api/internal/tls-ask",
    ]) {
      const res = proxy(
        new NextRequest(`https://track.client.com${blockedPath}`, {
          headers: { host: "track.client.com" },
        })
      );
      expect(res.status).toBe(404);
    }

    // Primary app domain continues normal auth behavior
    const primaryAppRedirect = proxy(
      new NextRequest("https://app.leadreach.test/app/outreach", {
        headers: { host: "app.leadreach.test" },
      })
    );
    expect(primaryAppRedirect.status).toBe(307);
    expect(primaryAppRedirect.headers.get("location")).toContain("/login");
  });
});
