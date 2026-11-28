import { ImageResponse } from "next/og";
import { getSiteBranding } from "@/server/branding";

export const alt =
  "B2B Lead Discovery, Cold Email Outreach & Social Automation";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

const CAPABILITIES = [
  "Cold Email Outreach",
  "Spintax & A/B Testing",
  "AI Reply Categorization",
  "Custom Tracking Domain",
  "Self Warm-up Pool",
  "Scheduled Social Posts",
];

export default async function OpenGraphImage() {
  const branding = await getSiteBranding();
  const siteName = branding.site_name || "Lead Reach AI";
  const initials =
    siteName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("") || "LR";
  const headline =
    branding.hero_title ||
    branding.tagline ||
    "Multi-Tenant B2B Outreach, Lead Discovery & Social Automation";
  const subtitle =
    branding.seo_description ||
    branding.hero_subtitle ||
    "Rate-capped cold email campaigns, IMAP stop-on-reply, private self warm-up pools, and custom tracking domains in one workspace.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0a0d12",
          color: "#f8fafc",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              backgroundColor: "#10b981",
              color: "#052e16",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "24px",
              fontWeight: 800,
            }}
          >
            {initials}
          </div>
          <div style={{ fontSize: "26px", fontWeight: 700, letterSpacing: "-0.02em" }}>
            {siteName}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "980px" }}>
          <div
            style={{
              fontSize: "54px",
              fontWeight: 800,
              lineHeight: 1.12,
              letterSpacing: "-0.03em",
              color: "#ffffff",
            }}
          >
            {headline}
          </div>
          <div
            style={{
              fontSize: "24px",
              lineHeight: 1.4,
              color: "#94a3b8",
            }}
          >
            {subtitle}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          {CAPABILITIES.map((item) => (
            <div
              key={item}
              style={{
                padding: "10px 18px",
                borderRadius: "9999px",
                border: "1px solid #1e293b",
                backgroundColor: "#111827",
                color: "#34d399",
                fontSize: "18px",
                fontWeight: 600,
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
