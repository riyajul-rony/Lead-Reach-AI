import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getCspHeaderConfig } from "@/lib/csp";
import { proxy } from "@/proxy";

describe("Phase 5 Step 5: Runtime Content-Security-Policy Enforcement", () => {
  const prevReportOnly = process.env.CSP_REPORT_ONLY;
  const prevAppUrl = process.env.APP_URL;
  const prevAppDomain = process.env.APP_DOMAIN;

  afterEach(() => {
    process.env.CSP_REPORT_ONLY = prevReportOnly;
    process.env.APP_URL = prevAppUrl;
    process.env.APP_DOMAIN = prevAppDomain;
  });

  it("enforces Content-Security-Policy by default with hardened directives", () => {
    const cfg = getCspHeaderConfig({
      NODE_ENV: "production",
      APP_URL: "https://leadreachai.cerkitlabs.tech",
    });

    expect(cfg.headerName).toBe("Content-Security-Policy");
    expect(cfg.value).toContain("frame-ancestors 'none'");
    expect(cfg.value).toContain("object-src 'none'");
    expect(cfg.value).toContain("base-uri 'self'");
    expect(cfg.value).toContain("form-action 'self'");
    expect(cfg.value).toContain("upgrade-insecure-requests");
  });

  it("omits upgrade-insecure-requests in non-production or localhost HTTP", () => {
    const devCfg = getCspHeaderConfig({ NODE_ENV: "development" });
    expect(devCfg.value).not.toContain("upgrade-insecure-requests");

    const localProdCfg = getCspHeaderConfig({
      NODE_ENV: "production",
      APP_URL: "http://localhost:3000",
    });
    expect(localProdCfg.value).not.toContain("upgrade-insecure-requests");
  });

  it("switches to Content-Security-Policy-Report-Only dynamically at runtime when CSP_REPORT_ONLY=true", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    process.env.APP_DOMAIN = "leadreachai.cerkitlabs.tech";
    delete process.env.CSP_REPORT_ONLY;

    const enforcedRes = proxy(
      new NextRequest("https://leadreachai.cerkitlabs.tech/login", {
        headers: { host: "leadreachai.cerkitlabs.tech" },
      })
    );
    expect(enforcedRes.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(enforcedRes.headers.get("Content-Security-Policy-Report-Only")).toBeNull();

    // Flip runtime env var without rebuilding
    process.env.CSP_REPORT_ONLY = "true";
    const reportOnlyRes = proxy(
      new NextRequest("https://leadreachai.cerkitlabs.tech/", {
        headers: { host: "leadreachai.cerkitlabs.tech" },
      })
    );
    expect(reportOnlyRes.headers.get("Content-Security-Policy-Report-Only")).toContain("frame-ancestors 'none'");
    expect(reportOnlyRes.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("sets enforcing CSP header across /, /login, /app/*, and /admin/*", () => {
    process.env.APP_URL = "https://leadreachai.cerkitlabs.tech";
    process.env.APP_DOMAIN = "leadreachai.cerkitlabs.tech";
    process.env.CSP_REPORT_ONLY = "false";

    for (const path of ["/", "/login", "/app/dashboard", "/admin/users"]) {
      const res = proxy(
        new NextRequest(`https://leadreachai.cerkitlabs.tech${path}`, {
          headers: { host: "leadreachai.cerkitlabs.tech" },
        })
      );
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    }
  });
});
