import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, createSession } from "@/server/auth/session";
import { exchangeGoogleCode, saveGoogleConnection } from "@/server/integrations/google-sheets";
import { db } from "@/server/db";
import { getConfig, getAppUrl, getRegistrationMode } from "@/server/config";
import { startFreeTrialForUser } from "@/server/billing/trial";
import { logger } from "@/server/logger";
import {
  OAUTH_STATE_COOKIE,
  sanitizeReturnTo,
  verifyOAuthState,
} from "@/server/auth/oauth-state";

export async function GET(req: NextRequest) {
  const appUrl = await getAppUrl();
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const stateRaw = req.nextUrl.searchParams.get("state");
  const cookieNonce = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  const verified = verifyOAuthState(stateRaw, cookieNonce);
  const clearStateCookie = (res: NextResponse) => {
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  };

  if (!verified.valid) {
    logger.warn({ reason: verified.error }, "Google OAuth callback rejected invalid state");
    return clearStateCookie(
      NextResponse.redirect(new URL("/login?error=invalid_oauth_state", appUrl))
    );
  }

  const mode = verified.mode || "connect";
  const defaultReturn = mode === "login" ? "/app" : "/app/leads/google_maps";
  const returnTo = sanitizeReturnTo(verified.returnTo, defaultReturn);

  if (error || !code) {
    logger.warn({ error }, "Google OAuth callback error or user cancelled");
    const dest = mode === "login" ? "/login" : returnTo;
    return clearStateCookie(
      NextResponse.redirect(new URL(`${dest}?error=google_auth_failed`, appUrl))
    );
  }

  try {
    const tokens = await exchangeGoogleCode(code);

    // MODE 1: USER AUTHENTICATION (Sign In / Sign Up with Google)
    if (mode === "login") {
      const email = tokens.email?.toLowerCase();
      if (!email) {
        return clearStateCookie(
          NextResponse.redirect(new URL("/login?error=no_email_provided", appUrl))
        );
      }

      let user = await db.users.findUnique({ where: { email } });

      if (user) {
        if (user.status !== "active") {
          return clearStateCookie(
            NextResponse.redirect(new URL("/login?error=account_inactive", appUrl))
          );
        }
        if (!user.email_verified_at) {
          await db.users.update({ where: { id: user.id }, data: { email_verified_at: new Date() } });
        }
        await db.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
      } else {
        // New user registration
        const userCount = await db.users.count();
        const adminEmail = (await getConfig("ADMIN_EMAIL"))?.toLowerCase();
        const isAdmin = userCount === 0 || (!!adminEmail && adminEmail === email);

        const regMode = await getRegistrationMode();
        if (!isAdmin && regMode === "closed") {
          return clearStateCookie(
            NextResponse.redirect(new URL("/signup?error=registration_closed", appUrl))
          );
        }

        if (!isAdmin && regMode === "invite") {
          return clearStateCookie(
            NextResponse.redirect(new URL("/login?error=invite_only", appUrl))
          );
        }

        const defaultPlan = (await getConfig("DEFAULT_PLAN")) || "free";

        user = await db.users.create({
          data: {
            email,
            name: tokens.name || email.split("@")[0],
            email_verified_at: new Date(),
            role: isAdmin ? "super_admin" : "user",
            status: "active",
            plan: defaultPlan,
            workspaces: { create: { name: "Default", is_default: true } },
            user_settings: { create: {} },
            oauth_accounts: {
              create: {
                provider: "google",
                provider_account_id: email,
              },
            },
          },
        });
        await startFreeTrialForUser(user.id);
      }

      // Save Google tokens for this user for Sheets and Outreach integrations
      try {
        await saveGoogleConnection(user.id, tokens);
      } catch (connErr) {
        logger.warn({ connErr }, "Could not auto-link google connection tokens");
      }

      // Establish session cookie
      await createSession(user.id);

      const targetPath = user.onboarded_at ? returnTo : "/onboarding";
      return clearStateCookie(NextResponse.redirect(new URL(targetPath, appUrl)));
    }

    // MODE 2: CONNECTING GOOGLE SHEETS FOR EXISTING USER SESSION
    const session = await getSessionUser();
    if (!session || !verified.userId || session.user.id !== verified.userId) {
      return clearStateCookie(
        NextResponse.redirect(new URL("/login?error=unauthorized", appUrl))
      );
    }

    await saveGoogleConnection(session.user.id, tokens);
    return clearStateCookie(
      NextResponse.redirect(new URL(`${returnTo}?google_connected=true`, appUrl))
    );
  } catch (err: any) {
    logger.error({ err }, "Failed to complete Google OAuth exchange");
    const failDest = mode === "login" ? "/login" : returnTo;
    return clearStateCookie(
      NextResponse.redirect(
        new URL(`${failDest}?error=${encodeURIComponent(err.message || "exchange_failed")}`, appUrl)
      )
    );
  }
}
