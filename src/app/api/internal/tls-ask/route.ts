import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import {
  getPrimaryAppHost,
  isValidPublicFqdn,
} from "@/server/email/tracking-domain-service";

const INTERNAL_HOSTS = new Set(["web", "localhost", "127.0.0.1", "::1", "[::1]"]);

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorizedInternalCaller(req: NextRequest): boolean {
  const configuredSecret = process.env.CTD_TLS_ASK_SECRET?.trim();
  if (configuredSecret) {
    const provided =
      req.headers.get("x-tls-ask-secret")?.trim() ||
      req.nextUrl.searchParams.get("secret")?.trim() ||
      "";
    return Boolean(provided) && safeCompareSecret(provided, configuredSecret);
  }

  // Without an explicit shared secret, reject proxied public internet traffic
  // and allow only direct container/local calls (e.g. Caddy calling http://web:3000/api/internal/tls-ask).
  if (req.headers.get("x-forwarded-for") || req.headers.get("x-forwarded-host")) {
    return false;
  }

  const hostHeader = (req.headers.get("host") || "").trim().toLowerCase();
  if (!hostHeader) return true;
  const hostNoPort = hostHeader.replace(/:\d+$/, "");
  return INTERNAL_HOSTS.has(hostNoPort);
}

/**
 * GET /api/internal/tls-ask?domain=track.client.com
 * Caddy on_demand_tls ask endpoint.
 * Strictly protected against public domain enumeration and non-FQDN probes.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedInternalCaller(req)) {
    return NextResponse.json({ allowed: false, error: "Forbidden" }, { status: 403 });
  }

  const rawDomain = (req.nextUrl.searchParams.get("domain") || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");

  if (!rawDomain || !isValidPublicFqdn(rawDomain)) {
    return NextResponse.json(
      { allowed: false, error: "Invalid domain" },
      { status: 400 }
    );
  }

  const primaryHost = getPrimaryAppHost();
  if (primaryHost && rawDomain === primaryHost) {
    return NextResponse.json({ allowed: true });
  }

  const verified = await db.tracking_domains.findFirst({
    where: { domain: rawDomain, status: "verified" },
    select: { id: true },
  });

  if (!verified) {
    return NextResponse.json({ allowed: false }, { status: 403 });
  }

  return NextResponse.json({ allowed: true });
}
