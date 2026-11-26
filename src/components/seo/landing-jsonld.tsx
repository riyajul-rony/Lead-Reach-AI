import { buildLandingJsonLd, serializeJsonLd } from "@/lib/landing-jsonld";
import type { SiteBranding } from "@/types/branding";

export function LandingJsonLd({
  siteUrl,
  branding,
}: {
  siteUrl: string;
  branding: SiteBranding;
}) {
  const payload = buildLandingJsonLd(siteUrl, branding);
  const safeJson = serializeJsonLd(payload);

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  );
}
