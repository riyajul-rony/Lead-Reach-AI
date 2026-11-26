import type { NextConfig } from "next";

const customDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:3000",
    ...customDevOrigins,
  ],
  experimental: {
    cpus: 1,
  },
  async headers() {
    const noIndexHeader = [
      {
        key: "X-Robots-Tag",
        value: "noindex, nofollow",
      },
    ];

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-ancestors 'none';",
          },
        ],
      },
      { source: "/app/:path*", headers: noIndexHeader },
      { source: "/admin/:path*", headers: noIndexHeader },
      { source: "/api/:path*", headers: noIndexHeader },
      { source: "/u/:path*", headers: noIndexHeader },
      { source: "/media/:path*", headers: noIndexHeader },
      { source: "/onboarding/:path*", headers: noIndexHeader },
      { source: "/login", headers: noIndexHeader },
      { source: "/signup", headers: noIndexHeader },
      { source: "/forgot-password", headers: noIndexHeader },
      { source: "/reset-password", headers: noIndexHeader },
      { source: "/verify-email", headers: noIndexHeader },
      { source: "/maintenance", headers: noIndexHeader },
      { source: "/dev/:path*", headers: noIndexHeader },
    ];
  },
};

export default nextConfig;
