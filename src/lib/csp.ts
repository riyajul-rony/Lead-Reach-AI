export type CspHeaderName =
  | "Content-Security-Policy"
  | "Content-Security-Policy-Report-Only";

export interface CspHeaderConfig {
  headerName: CspHeaderName;
  value: string;
}

/**
 * Builds the Content-Security-Policy header at runtime so emergency rollback via
 * CSP_REPORT_ONLY=true works without rebuilding the Next.js image.
 */
export function getCspHeaderConfig(
  env: Record<string, string | undefined> = process.env
): CspHeaderConfig {
  const reportOnly = env.CSP_REPORT_ONLY === "true";
  const isProd = env.NODE_ENV === "production";
  const appUrl = (env.APP_URL || "").trim().toLowerCase();
  const isLocalHttp =
    appUrl.startsWith("http://localhost") || appUrl.startsWith("http://127.0.0.1");

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (isProd && !isLocalHttp) {
    directives.push("upgrade-insecure-requests");
  }

  return {
    headerName: reportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy",
    value: `${directives.join("; ")};`,
  };
}
