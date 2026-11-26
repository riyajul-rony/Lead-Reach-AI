import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getMetadataBase, getSiteUrl } from "@/lib/site-url";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { proxy } from "@/proxy";
import nextConfig from "../../../next.config";
import { metadata as authMetadata } from "@/app/(auth)/layout";
import { metadata as appMetadata } from "@/app/app/layout";
import { metadata as adminMetadata } from "@/app/admin/layout";
import { metadata as onboardingMetadata } from "@/app/onboarding/page";
import { metadata as unsubscribeMetadata } from "@/app/u/[token]/page";
import { metadata as maintenanceMetadata } from "@/app/maintenance/page";
import { metadata as devUiMetadata } from "@/app/dev/ui/layout";
import { generateMetadata as generateHomeMetadata } from "@/app/page";

describe("Phase 4 Step 1: site-url, robots, sitemap & CTD isolation", () => {
  const prevAppUrl = process.env.APP_URL;
  const prevNextAuth = process.env.NEXTAUTH_URL;
  const prevAppDomain = process.env.APP_DOMAIN;

  afterEach(() => {
    process.env.APP_URL = prevAppUrl;
    process.env.NEXTAUTH_URL = prevNextAuth;
    process.env.APP_DOMAIN = prevAppDomain;
  });

  it("resolves siteUrl and metadataBase safely when env vars are empty or malformed", () => {
    process.env.APP_URL = "";
    process.env.NEXTAUTH_URL = "";
    process.env.APP_DOMAIN = "";

    expect(getSiteUrl()).toBe("https://leadreachai.cerkitlabs.tech");
    expect(getMetadataBase().toString()).toBe("https://leadreachai.cerkitlabs.tech/");

    process.env.APP_URL = "not-a-valid-url";
    expect(getSiteUrl()).toBe("https://leadreachai.cerkitlabs.tech");

    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech/some-path/";
    expect(getSiteUrl()).toBe("https://leadreachai.cerkitlabs.tech");
  });

  it("generates robots.txt rules disallowing private/auth/api routes and pointing to sitemap.xml", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    const result = robots();

    expect(result.sitemap).toBe("https://leadreachai.cerkitlabs.tech/sitemap.xml");
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules?.disallow).toEqual(
      expect.arrayContaining([
        "/app/",
        "/admin/",
        "/api/",
        "/u/",
        "/login",
        "/signup",
        "/onboarding",
      ])
    );
    expect(rules?.allow).toEqual(
      expect.arrayContaining(["/", "/privacy", "/terms", "/data-deletion"])
    );
  });

  it("generates sitemap.xml containing only public indexable routes", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    const entries = sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toEqual([
      "https://leadreachai.cerkitlabs.tech/",
      "https://leadreachai.cerkitlabs.tech/privacy",
      "https://leadreachai.cerkitlabs.tech/terms",
      "https://leadreachai.cerkitlabs.tech/data-deletion",
    ]);

    for (const url of urls) {
      expect(url).not.toMatch(/\/(app|admin|api|u|login|signup|onboarding)/);
    }
  });

  it("blocks sitemap.xml, llms.txt, and landing page on custom tracking domains and disallows crawling in robots.txt", async () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    process.env.APP_DOMAIN = "leadreachai.cerkitlabs.tech";

    for (const blockedPath of ["/", "/sitemap.xml", "/llms.txt", "/privacy"]) {
      const res = proxy(
        new NextRequest(`https://track.client.com${blockedPath}`, {
          headers: { host: "track.client.com" },
        })
      );
      expect(res.status).toBe(404);
    }

    const robotsRes = proxy(
      new NextRequest("https://track.client.com/robots.txt", {
        headers: { host: "track.client.com" },
      })
    );
    expect(robotsRes.status).toBe(200);
    const body = await robotsRes.text();
    expect(body).toContain("Disallow: /");
    expect(robotsRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("Phase 4 Step 2: strict noindex, nofollow on private/auth/api routes", () => {
  const prevAppUrl = process.env.APP_URL;
  const prevAppDomain = process.env.APP_DOMAIN;

  afterEach(() => {
    process.env.APP_URL = prevAppUrl;
    process.env.APP_DOMAIN = prevAppDomain;
  });

  it("sets X-Robots-Tag: noindex, nofollow on private, auth, api, media, and unsubscribe paths via proxy", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    process.env.APP_DOMAIN = "leadreachai.cerkitlabs.tech";

    const privatePaths = [
      "/app",
      "/app/dashboard",
      "/app/warmup",
      "/admin",
      "/admin/users",
      "/api/v1/leads",
      "/u/tok123",
      "/media/tok123",
      "/onboarding",
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/maintenance",
      "/dev/ui",
    ];

    for (const p of privatePaths) {
      const res = proxy(
        new NextRequest(`https://leadreachai.cerkitlabs.tech${p}`, {
          headers: { host: "leadreachai.cerkitlabs.tech" },
        })
      );
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });

  it("does NOT set X-Robots-Tag on public landing or legal pages", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    process.env.APP_DOMAIN = "leadreachai.cerkitlabs.tech";

    for (const p of ["/", "/privacy", "/terms", "/data-deletion"]) {
      const res = proxy(
        new NextRequest(`https://leadreachai.cerkitlabs.tech${p}`, {
          headers: { host: "leadreachai.cerkitlabs.tech" },
        })
      );
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  it("configures X-Robots-Tag headers in next.config.ts for private/auth/api/media/unsubscribe paths", async () => {
    const rules = (await nextConfig.headers?.()) || [];
    const bySource = new Map(rules.map((r) => [r.source, r.headers]));

    for (const src of [
      "/app/:path*",
      "/admin/:path*",
      "/api/:path*",
      "/u/:path*",
      "/media/:path*",
      "/onboarding/:path*",
      "/login",
      "/signup",
    ]) {
      const headers = bySource.get(src) || [];
      expect(headers).toContainEqual({
        key: "X-Robots-Tag",
        value: "noindex, nofollow",
      });
    }

    const rootHeaders = bySource.get("/:path*") || [];
    expect(rootHeaders.find((h) => h.key === "X-Robots-Tag")).toBeUndefined();
  });

  it("exports robots: { index: false, follow: false } on private/auth metadata and NOT on landing page", async () => {
    const privateMetas = [
      authMetadata,
      appMetadata,
      adminMetadata,
      onboardingMetadata,
      unsubscribeMetadata,
      maintenanceMetadata,
      devUiMetadata,
    ];

    for (const meta of privateMetas) {
      expect(meta.robots).toEqual({ index: false, follow: false });
    }

    const homeMeta = await generateHomeMetadata();
    expect((homeMeta as { robots?: unknown }).robots).toBeUndefined();
  });
});
