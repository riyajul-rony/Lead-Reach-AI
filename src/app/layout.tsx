import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getSiteBranding } from "@/server/branding";
import { getMetadataBase } from "@/lib/site-url";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getSiteBranding();
  const siteName = branding.site_name || "Lead Reach AI";
  const title = branding.seo_title || `${siteName} — ${branding.tagline}`;
  const description = branding.seo_description || branding.hero_subtitle || branding.tagline;
  const customOgImage = branding.og_image?.trim();

  const icons: Metadata["icons"] = branding.favicon_url
    ? [{ url: branding.favicon_url, rel: "icon" }]
    : [{ url: "/favicon.ico", rel: "icon" }];

  const openGraph: Metadata["openGraph"] = {
    type: "website",
    title,
    description,
    siteName,
    ...(customOgImage
      ? {
          images: [{ url: customOgImage, width: 1200, height: 630, alt: siteName }],
        }
      : {}),
  };

  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title,
    description,
    ...(customOgImage ? { images: [customOgImage] } : {}),
  };

  return {
    metadataBase: getMetadataBase(),
    title: {
      default: title,
      template: `%s | ${siteName}`,
    },
    description,
    icons,
    openGraph,
    twitter,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [cookieStore, branding] = await Promise.all([
    cookies(),
    getSiteBranding(),
  ]);
  const themeCookie =
    cookieStore.get("leadreach_theme")?.value ||
    cookieStore.get("autohub_theme")?.value;
  const initialTheme = themeCookie === "light" ? "light" : "dark";

  return (
    <html
      lang="en"
      data-theme={initialTheme}
      suppressHydrationWarning
      className="h-full antialiased font-sans"
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {branding.favicon_url && (
          <>
            <link rel="icon" href={branding.favicon_url} />
            <link rel="shortcut icon" href={branding.favicon_url} />
            <link rel="apple-touch-icon" href={branding.favicon_url} />
          </>
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('leadreach_theme')||localStorage.getItem('autohub_theme');var theme=(t==='light')?'light':'dark';document.documentElement.setAttribute('data-theme',theme);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-text">{children}</body>
    </html>
  );
}
