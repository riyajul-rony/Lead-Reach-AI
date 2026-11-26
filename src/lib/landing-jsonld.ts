import { LANDING_FAQS } from "@/lib/landing-faq";
import type { SiteBranding } from "@/types/branding";

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function buildLandingJsonLd(siteUrl: string, branding: SiteBranding) {
  const siteName = branding.site_name || "Lead Reach AI";
  const description =
    branding.seo_description ||
    "Multi-tenant B2B lead discovery, cold email outreach with spintax and A/B testing, AI reply categorization, custom tracking domains, private self warm-up pools, and scheduled social posting.";

  const sameAs = [branding.twitter_url, branding.linkedin_url, branding.github_url]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u));

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: siteName,
        url: siteUrl,
        ...(branding.support_email
          ? {
              contactPoint: {
                "@type": "ContactPoint",
                contactType: "customer support",
                email: branding.support_email,
              },
            }
          : {}),
        ...(sameAs.length > 0 ? { sameAs } : {}),
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${siteUrl}/#software`,
        name: siteName,
        url: siteUrl,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description,
        publisher: {
          "@id": `${siteUrl}/#organization`,
        },
        featureList: [
          "Cold email outreach with 25/hour mailbox rate caps and randomized jitter",
          "Nested spintax resolution and campaign A/B testing variants",
          "Automated IMAP Stop-on-Reply and AI reply categorization with manual override",
          "Private self warm-up pool between user's own connected accounts",
          "Custom tracking domains (CNAME) with DNS verification",
          "Lead discovery for Google Maps, LinkedIn B2B, and Meta Ads Library",
          "Scheduled social posting for Facebook Pages, Instagram, and LinkedIn",
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${siteUrl}/#faq`,
        mainEntity: LANDING_FAQS.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        })),
      },
    ],
  };
}
