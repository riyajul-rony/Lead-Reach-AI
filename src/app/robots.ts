import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/privacy", "/terms", "/acceptable-use", "/data-deletion"],
        disallow: [
          "/app/",
          "/admin/",
          "/api/",
          "/u/",
          "/onboarding",
          "/login",
          "/signup",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
          "/maintenance",
          "/dev/",
          "/media/",
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
