import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/server/integrations/google-sheets";
import { getAppUrl } from "@/server/config";
import { getSessionUser } from "@/server/auth/session";
import {
  OAUTH_STATE_COOKIE,
  createOAuthState,
  sanitizeReturnTo,
} from "@/server/auth/oauth-state";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") || "connect";
  const defaultReturn = mode === "login" ? "/app" : "/app/leads/google_maps";
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("returnTo"), defaultReturn);

  let userId: string | undefined;
  if (mode !== "login") {
    const session = await getSessionUser();
    if (!session) {
      if (req.headers.get("accept")?.includes("application/json")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const appUrl = await getAppUrl();
      return NextResponse.redirect(new URL("/login?error=unauthorized", appUrl));
    }
    userId = session.user.id;
  }

  const { state, nonce } = createOAuthState({ mode, userId, returnTo });

  const result = await getGoogleAuthUrl(state);
  if (result.error || !result.url) {
    if (mode === "login") {
      const appUrl = await getAppUrl();
      return NextResponse.redirect(new URL("/login?error=google_not_configured", appUrl));
    }
    return NextResponse.json({ error: result.error || "Google OAuth not configured" }, { status: 400 });
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
