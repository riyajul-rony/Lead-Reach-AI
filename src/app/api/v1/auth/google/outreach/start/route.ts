import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getGoogleOutreachAuthUrl } from "@/server/email/google-oauth";
import { assertLimit } from "@/server/billing/limits";
import { getAppUrl } from "@/server/config";
import {
  OAUTH_STATE_COOKIE,
  createOAuthState,
  sanitizeReturnTo,
} from "@/server/auth/oauth-state";

export async function GET(req: NextRequest) {
  const appUrl = await getAppUrl();
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.redirect(new URL("/login?error=unauthorized", appUrl));
  }

  // Pre-check plan limits for email accounts
  try {
    await assertLimit(session.user.id, "max_email_accounts", 1);
  } catch (limitErr: any) {
    const errorMsg = encodeURIComponent(limitErr.message || "Account limit reached");
    return NextResponse.redirect(
      new URL(`/app/outreach/email-accounts?error=${errorMsg}`, appUrl)
    );
  }

  const returnTo = sanitizeReturnTo(
    req.nextUrl.searchParams.get("returnTo"),
    "/app/outreach/email-accounts"
  );
  const includeRead = req.nextUrl.searchParams.get("includeRead") === "true";
  const { state, nonce } = createOAuthState({
    mode: "outreach",
    userId: session.user.id,
    returnTo,
  });

  const result = await getGoogleOutreachAuthUrl(session.user.id, {
    returnTo,
    includeReadScope: includeRead,
    state,
  });

  if (result.error || !result.url) {
    const errorMsg = encodeURIComponent(result.error || "Google OAuth not configured");
    return NextResponse.redirect(
      new URL(`/app/outreach/email-accounts?error=${errorMsg}`, appUrl)
    );
  }

  const res = req.headers.get("accept")?.includes("application/json")
    ? NextResponse.json({ url: result.url })
    : NextResponse.redirect(result.url);

  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return res;
}
