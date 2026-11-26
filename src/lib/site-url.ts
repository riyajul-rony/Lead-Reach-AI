const DEFAULT_SITE_URL = "https://leadreachai.cerkitlabs.tech";

function parseOrigin(raw: string | undefined, allowBareHost: boolean): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!trimmed.includes("://")) {
    if (!allowBareHost) return null;
    if (trimmed.includes(" ") || (!trimmed.includes(".") && trimmed !== "localhost")) {
      return null;
    }
    candidate = `https://${trimmed}`;
  }

  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname &&
      (parsed.hostname === "localhost" || parsed.hostname.includes("."))
    ) {
      return parsed.origin;
    }
  } catch {
    // Ignore invalid URL candidate
  }

  return null;
}

/**
 * Resolves the canonical public application URL safely without throwing during
 * zero-secret builds or when env vars are empty/malformed.
 */
export function getSiteUrl(): string {
  return (
    parseOrigin(process.env.APP_URL, false) ||
    parseOrigin(process.env.NEXTAUTH_URL, false) ||
    parseOrigin(process.env.APP_DOMAIN, true) ||
    DEFAULT_SITE_URL
  );
}

/**
 * Returns a valid URL instance for Next.js metadataBase without throwing
 * when APP_URL is unset at build time.
 */
export function getMetadataBase(): URL {
  try {
    return new URL(getSiteUrl());
  } catch {
    return new URL(DEFAULT_SITE_URL);
  }
}
