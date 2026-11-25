import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function normalizeHost(raw: string | null): string {
  if (!raw) return "";
  const first = raw.split(",")[0]?.trim().toLowerCase() || "";
  if (first.startsWith("[")) {
    const endIdx = first.indexOf("]");
    return endIdx >= 0 ? first.slice(0, endIdx + 1) : first;
  }
  return first.replace(/:\d+$/, "");
}

function getPrimaryHosts(): Set<string> {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "web", "::1", "[::1]"]);
  const candidates = [
    process.env.APP_DOMAIN,
    process.env.APP_URL,
    process.env.NEXTAUTH_URL,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = c.includes("://") ? new URL(c) : new URL(`https://${c}`);
      const h = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
      if (h) hosts.add(h);
    } catch {}
  }
  return hosts;
}

function isAllowedCustomDomainPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/track" ||
    pathname.startsWith("/api/v1/track/") ||
    pathname === "/api/v1/unsubscribe" ||
    pathname.startsWith("/api/v1/unsubscribe/") ||
    pathname.startsWith("/u/")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Enforce strict path allowlist for custom tracking domains (CNAME traffic)
  const requestHost = normalizeHost(
    request.headers.get("x-forwarded-host") ||
      request.headers.get("host") ||
      request.nextUrl.host
  );
  const primaryHosts = getPrimaryHosts();

  if (requestHost && !primaryHosts.has(requestHost)) {
    if (!isAllowedCustomDomainPath(pathname)) {
      return new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.next();
  }

  const sessionToken =
    request.cookies.get("leadreach_session")?.value ||
    request.cookies.get("autohub_session")?.value;

  const isProtected =
    pathname.startsWith("/app") ||
    pathname.startsWith("/onboarding") ||
    pathname.startsWith("/admin");

  if (isProtected && !sessionToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
