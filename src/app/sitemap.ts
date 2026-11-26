import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  const legalUpdated = new Date("2026-10-01T00:00:00.000Z");

  return [
    {
      url: `${siteUrl}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified: legalUpdated,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified: legalUpdated,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${siteUrl}/acceptable-use`,
      lastModified: legalUpdated,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${siteUrl}/data-deletion`,
      lastModified: legalUpdated,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
