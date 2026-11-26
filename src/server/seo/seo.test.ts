import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getMetadataBase, getSiteUrl } from "@/lib/site-url";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { proxy } from "@/proxy";

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
