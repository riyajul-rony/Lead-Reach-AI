import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/globals.css", () => ({}));

import { getMetadataBase, getSiteUrl } from "@/lib/site-url";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { proxy } from "@/proxy";
import nextConfig from "../../../next.config";
import { generateMetadata as generateRootMetadata } from "@/app/layout";
import OpenGraphImage, { size as ogSize, contentType as ogContentType } from "@/app/opengraph-image";
import { metadata as authMetadata } from "@/app/(auth)/layout";
import { metadata as appMetadata } from "@/app/app/layout";
import { metadata as adminMetadata } from "@/app/admin/layout";
import { metadata as onboardingMetadata } from "@/app/onboarding/page";
import { metadata as unsubscribeMetadata } from "@/app/u/[token]/page";
import { metadata as maintenanceMetadata } from "@/app/maintenance/page";
import { metadata as devUiMetadata } from "@/app/dev/ui/layout";
import { generateMetadata as generateHomeMetadata } from "@/app/page";
import { metadata as privacyMetadata } from "@/app/privacy/page";
import { metadata as termsMetadata } from "@/app/terms/page";
import { metadata as acceptableUseMetadata } from "@/app/acceptable-use/page";
import { metadata as dataDeletionMetadata } from "@/app/data-deletion/page";
import { GET as getLlmsTxt } from "@/app/llms.txt/route";
import { LANDING_FAQS } from "@/lib/landing-faq";
import { buildLandingJsonLd, serializeJsonLd } from "@/lib/landing-jsonld";
import { DEFAULT_BRANDING } from "@/types/branding";

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
      expect.arrayContaining(["/", "/privacy", "/terms", "/acceptable-use", "/data-deletion"])
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
      "https://leadreachai.cerkitlabs.tech/acceptable-use",
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

    for (const p of ["/", "/privacy", "/terms", "/acceptable-use", "/data-deletion"]) {
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

describe("Phase 4 Step 3: metadataBase, canonical URLs, OpenGraph & Twitter cards", () => {
  const prevAppUrl = process.env.APP_URL;

  afterEach(() => {
    process.env.APP_URL = prevAppUrl;
  });

  it("configures metadataBase, title template, OpenGraph, and Twitter card without overriding opengraph-image when og_image is unset", async () => {
    process.env.APP_URL = "";
    const meta = await generateRootMetadata();

    expect(meta.metadataBase?.toString()).toBe("https://leadreachai.cerkitlabs.tech/");
    expect(meta.title).toEqual({
      default: expect.stringContaining("Lead Reach AI"),
      template: "%s | Lead Reach AI",
    });
    expect(meta.openGraph).toMatchObject({
      type: "website",
      siteName: "Lead Reach AI",
    });
    expect((meta.openGraph as { images?: unknown }).images).toBeUndefined();
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
    });
    expect((meta.twitter as { images?: unknown }).images).toBeUndefined();
  });

  it("defines per-page canonical URLs and social cards on all public routes", async () => {
    const homeMeta = await generateHomeMetadata();
    expect(homeMeta.alternates?.canonical).toBe("/");
    expect(homeMeta.openGraph).toMatchObject({ type: "website", url: "/" });
    expect(homeMeta.twitter).toMatchObject({ card: "summary_large_image" });

    const publicPages = [
      { meta: privacyMetadata, path: "/privacy" },
      { meta: termsMetadata, path: "/terms" },
      { meta: acceptableUseMetadata, path: "/acceptable-use" },
      { meta: dataDeletionMetadata, path: "/data-deletion" },
    ];

    for (const { meta, path } of publicPages) {
      expect(meta.alternates?.canonical).toBe(path);
      expect(meta.openGraph).toMatchObject({ type: "website", url: path });
      expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
      expect(typeof meta.title).toBe("string");
      expect(typeof meta.description).toBe("string");
    }
  });

  it("generates a 1200x630 PNG opengraph-image without external network calls", async () => {
    expect(ogSize).toEqual({ width: 1200, height: 630 });
    expect(ogContentType).toBe("image/png");
    const response = await OpenGraphImage();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
  });
});

describe("Phase 4 Step 4: llms.txt, JSON-LD structured data & visible FAQ parity", () => {
  const prevAppUrl = process.env.APP_URL;

  afterEach(() => {
    process.env.APP_URL = prevAppUrl;
  });

  it("serves structured llms.txt using runtime APP_URL and truthful capabilities", async () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    const res = await getLlmsTxt();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("# Lead Reach AI");
    expect(text).toContain("https://leadreachai.cerkitlabs.tech/");
    expect(text).toContain("Private Self Warm-up Pool");
    expect(text).toContain("Custom Tracking Domains");
    expect(text).toContain("Spintax");
    expect(text).toContain("A/B Testing");
    expect(text).toContain("AI Reply Categorization");
    expect(text).toContain("manual plan activation");
    expect(text).not.toMatch(/stripe/i);
  });

  it("escapes <, >, and & in serializeJsonLd to prevent </script> XSS injection", () => {
    const serialized = serializeJsonLd({
      name: "</script><script>alert('xss')</script> & test",
    });
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("&");
    expect(serialized).toContain("\\u003c/script\\u003e");
  });

  it("builds valid Organization, SoftwareApplication, and FAQPage JSON-LD matching LANDING_FAQS verbatim", () => {
    expect(LANDING_FAQS.length).toBeGreaterThanOrEqual(6);
    expect(LANDING_FAQS.length).toBeLessThanOrEqual(8);

    const payload = buildLandingJsonLd("https://leadreachai.cerkitlabs.tech", DEFAULT_BRANDING);
    const graph = payload["@graph"];
    expect(graph).toHaveLength(3);

    const org = graph[0] as Record<string, unknown>;
    const app = graph[1] as Record<string, unknown>;
    const faq = graph[2] as {
      "@type": string;
      mainEntity: Array<{
        "@type": string;
        name: string;
        acceptedAnswer: { "@type": string; text: string };
      }>;
    };

    expect(org["@type"]).toBe("Organization");
    expect(app["@type"]).toBe("SoftwareApplication");
    expect(app.aggregateRating).toBeUndefined();

    expect(faq["@type"]).toBe("FAQPage");
    expect(faq.mainEntity).toHaveLength(LANDING_FAQS.length);

    faq.mainEntity.forEach((entry, idx) => {
      expect(entry["@type"]).toBe("Question");
      expect(entry.name).toBe(LANDING_FAQS[idx].question);
      expect(entry.acceptedAnswer["@type"]).toBe("Answer");
      expect(entry.acceptedAnswer.text).toBe(LANDING_FAQS[idx].answer);
    });
  });
});
