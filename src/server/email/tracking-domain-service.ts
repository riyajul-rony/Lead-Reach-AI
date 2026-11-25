import dns from "node:dns/promises";
import { db } from "@/server/db";

const DNS_TIMEOUT_MS = 5000;
const MAX_TRACKING_DOMAINS_PER_USER = 20;

const IPV4_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_REGEX = /^[a-z]{2,63}$/;

export function getDefaultBaseUrl(): string {
  const raw =
    process.env.NEXTAUTH_URL ||
    process.env.APP_URL ||
    "http://localhost:3000";
  return raw.trim().replace(/\/+$/, "");
}

export function extractHostname(urlOrHost: string | undefined | null): string | null {
  if (!urlOrHost || typeof urlOrHost !== "string") return null;
  const trimmed = urlOrHost.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    const parsed = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return parsed.hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function getPrimaryAppHost(): string | null {
  return (
    extractHostname(process.env.APP_DOMAIN) ||
    extractHostname(process.env.APP_URL) ||
    extractHostname(process.env.NEXTAUTH_URL)
  );
}

export function getDefaultCnameTarget(): string {
  const configured = extractHostname(process.env.TRACKING_CNAME_TARGET);
  if (configured && configured !== "localhost") return configured;
  return getPrimaryAppHost() || "localhost";
}

/**
 * Strictly validates that an input string is a valid public FQDN (no IPs, wildcards,
 * ports, paths, protocols, or local/internal reserved hostnames).
 */
export function isValidPublicFqdn(raw: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");

  if (domain.length < 3 || domain.length > 253) return false;
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes(":") ||
    domain.includes("*") ||
    domain.includes("@") ||
    domain.includes("[") ||
    domain.includes("]") ||
    /\s/.test(domain)
  ) {
    return false;
  }

  if (IPV4_REGEX.test(domain)) return false;

  if (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".local") ||
    domain.endsWith(".internal") ||
    domain.endsWith(".lan") ||
    domain.endsWith(".home.arpa")
  ) {
    return false;
  }

  const labels = domain.split(".");
  if (labels.length < 2) return false;

  for (const label of labels) {
    if (!DNS_LABEL_REGEX.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  if (!TLD_REGEX.test(tld)) return false;

  return true;
}

export function normalizeTrackingDomain(input: string): string {
  if (typeof input !== "string") {
    throw new Error("Domain is required.");
  }
  const normalized = input.trim().toLowerCase().replace(/\.+$/, "");

  if (!isValidPublicFqdn(normalized)) {
    throw new Error(
      "Please enter a valid public domain or subdomain (e.g. track.yourdomain.com). IPs, wildcards, ports, and localhost are not allowed."
    );
  }

  const primaryHost = getPrimaryAppHost();
  if (primaryHost && normalized === primaryHost) {
    throw new Error(
      `Cannot register the primary application domain (${primaryHost}) as a custom tracking domain. Use a subdomain such as track.yourdomain.com.`
    );
  }

  return normalized;
}

async function resolveCnameWithTimeout(domain: string): Promise<string[]> {
  return await Promise.race([
    dns.resolveCname(domain),
    new Promise<string[]>((_, reject) =>
      setTimeout(() => reject(new Error("DNS CNAME lookup timed out")), DNS_TIMEOUT_MS)
    ),
  ]);
}

export async function listTrackingDomains(
  userId: string,
  opts: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, Number(opts.page || 1));
  const limit = Math.min(50, Math.max(1, Number(opts.limit || 20)));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    db.tracking_domains.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        domain: true,
        cname_target: true,
        status: true,
        is_default: true,
        last_checked_at: true,
        last_error: true,
        verified_at: true,
        created_at: true,
      },
    }),
    db.tracking_domains.count({ where: { user_id: userId } }),
  ]);

  return {
    items,
    total,
    page,
    limit,
    cnameTarget: getDefaultCnameTarget(),
  };
}

export async function createTrackingDomain(userId: string, domainInput: string) {
  const domain = normalizeTrackingDomain(domainInput);
  const existingCount = await db.tracking_domains.count({ where: { user_id: userId } });
  if (existingCount >= MAX_TRACKING_DOMAINS_PER_USER) {
    throw new Error(`Maximum of ${MAX_TRACKING_DOMAINS_PER_USER} tracking domains allowed per workspace.`);
  }

  const existing = await db.tracking_domains.findFirst({
    where: { domain },
    select: { id: true, user_id: true },
  });
  if (existing) {
    throw new Error(
      existing.user_id === userId
        ? `Domain ${domain} is already added to your workspace.`
        : `Domain ${domain} is already registered.`
    );
  }

  const cnameTarget = getDefaultCnameTarget();
  return await db.tracking_domains.create({
    data: {
      user_id: userId,
      domain,
      cname_target: cnameTarget,
      status: "pending",
      is_default: false,
    },
    select: {
      id: true,
      domain: true,
      cname_target: true,
      status: true,
      is_default: true,
      last_checked_at: true,
      last_error: true,
      verified_at: true,
      created_at: true,
    },
  });
}

export async function verifyTrackingDomainDns(
  userId: string,
  id: string,
  cnameResolver: (domain: string) => Promise<string[]> = resolveCnameWithTimeout
) {
  const record = await db.tracking_domains.findFirst({
    where: { id, user_id: userId },
    select: {
      id: true,
      user_id: true,
      domain: true,
      cname_target: true,
      status: true,
      is_default: true,
    },
  });
  if (!record) {
    throw new Error("Tracking domain not found.");
  }

  const expectedTarget = (record.cname_target || getDefaultCnameTarget())
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const now = new Date();

  let cnames: string[] = [];
  let lookupError: string | null = null;

  try {
    cnames = await cnameResolver(record.domain);
  } catch (err: any) {
    lookupError = err?.message || "No CNAME record found";
  }

  const normalizedCnames = (Array.isArray(cnames) ? cnames : []).map((c) =>
    String(c || "").trim().toLowerCase().replace(/\.$/, "")
  );
  const matched =
    normalizedCnames.length > 0 &&
    normalizedCnames.some((c) => c === expectedTarget);

  if (matched) {
    const existingDefault = await db.tracking_domains.findFirst({
      where: { user_id: userId, is_default: true },
      select: { id: true },
    });

    return await db.tracking_domains.update({
      where: { id: record.id },
      data: {
        status: "verified",
        verified_at: now,
        last_checked_at: now,
        last_error: null,
        is_default: record.is_default || !existingDefault,
      },
      select: {
        id: true,
        domain: true,
        cname_target: true,
        status: true,
        is_default: true,
        last_checked_at: true,
        last_error: true,
        verified_at: true,
        created_at: true,
      },
    });
  }

  const reason = lookupError
    ? `DNS check failed: ${lookupError}`
    : `CNAME points to [${normalizedCnames.join(", ") || "none"}], expected "${expectedTarget}".`;

  return await db.tracking_domains.update({
    where: { id: record.id },
    data: {
      status: "failed",
      last_checked_at: now,
      last_error: reason,
    },
    select: {
      id: true,
      domain: true,
      cname_target: true,
      status: true,
      is_default: true,
      last_checked_at: true,
      last_error: true,
      verified_at: true,
      created_at: true,
    },
  });
}

export async function setDefaultTrackingDomain(userId: string, id: string) {
  const record = await db.tracking_domains.findFirst({
    where: { id, user_id: userId },
    select: { id: true, status: true },
  });
  if (!record) {
    throw new Error("Tracking domain not found.");
  }
  if (record.status !== "verified") {
    throw new Error("Only verified tracking domains can be set as default.");
  }

  await db.tracking_domains.updateMany({
    where: { user_id: userId, id: { not: id } },
    data: { is_default: false },
  });

  return await db.tracking_domains.update({
    where: { id },
    data: { is_default: true },
    select: {
      id: true,
      domain: true,
      cname_target: true,
      status: true,
      is_default: true,
      last_checked_at: true,
      last_error: true,
      verified_at: true,
      created_at: true,
    },
  });
}

export async function deleteTrackingDomain(userId: string, id: string) {
  const record = await db.tracking_domains.findFirst({
    where: { id, user_id: userId },
    select: { id: true },
  });
  if (!record) {
    throw new Error("Tracking domain not found.");
  }
  await db.tracking_domains.delete({ where: { id } });
  return { deleted: true, id };
}

/**
 * Resolves the base URL for open/click/unsubscribe links for a campaign.
 * Returns https://<verified-domain> ONLY if a matching verified domain exists;
 * otherwise safely falls back to the application's primary BASE_URL.
 */
export async function resolveTrackingBaseUrl(
  userId: string,
  trackingDomainId?: string | null
): Promise<string> {
  const fallback = getDefaultBaseUrl();

  try {
    let domainRecord: { domain: string; status: string } | null = null;

    if (trackingDomainId) {
      domainRecord = await db.tracking_domains.findFirst({
        where: {
          id: trackingDomainId,
          user_id: userId,
          status: "verified",
        },
        select: { domain: true, status: true },
      });
    } else {
      domainRecord = await db.tracking_domains.findFirst({
        where: {
          user_id: userId,
          is_default: true,
          status: "verified",
        },
        select: { domain: true, status: true },
      });
    }

    if (
      domainRecord &&
      domainRecord.status === "verified" &&
      isValidPublicFqdn(domainRecord.domain)
    ) {
      return `https://${domainRecord.domain}`;
    }
  } catch {
    // Fallback to primary base URL on transient DB errors
  }

  return fallback;
}
