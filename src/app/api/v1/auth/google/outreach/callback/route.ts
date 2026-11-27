import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { exchangeGoogleOutreachCode } from "@/server/email/google-oauth";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { assertLimit } from "@/server/billing/limits";
import { logger } from "@/server/logger";
import { getAppUrl } from "@/server/config";
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

  const clearStateCookie = (res: NextResponse) => {
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  };

  const verified = verifyOAuthState(stateRaw, cookieNonce);
  if (!verified.valid || !verified.userId) {
    logger.warn({ reason: verified.error }, "Google outreach OAuth callback rejected invalid state");
    return clearStateCookie(
      NextResponse.redirect(new URL("/login?error=invalid_oauth_state", appUrl))
    );
  }

  const session = await getSessionUser();
  if (!session || session.user.id !== verified.userId) {
    return clearStateCookie(
      NextResponse.redirect(new URL("/login?error=unauthorized", appUrl))
    );
  }

  const effectiveUserId = session.user.id;
  const returnTo = sanitizeReturnTo(verified.returnTo, "/app/outreach/email-accounts");

  if (error || !code) {
    logger.warn({ error }, "Google outreach OAuth callback error or user denied access");
    return clearStateCookie(
      NextResponse.redirect(
        new URL(
          `${returnTo}?error=${encodeURIComponent(error || "Google authorization was cancelled")}`,
          appUrl
        )
      )
    );
  }

  try {
    const tokens = await exchangeGoogleOutreachCode(code);
    const emailLower = tokens.email.toLowerCase().trim();

    // Check if account already exists for this user
    const existing = await db.email_accounts.findUnique({
      where: {
        user_id_from_email: {
          user_id: effectiveUserId,
          from_email: emailLower,
        },
      },
    });

    const accessTokenEnc = encrypt(tokens.access_token);
    const refreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : existing?.oauth_refresh_token_enc || null;
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const scopesList = tokens.scope ? tokens.scope.split(" ") : [];

    if (existing) {
      // Reconnect / Refresh existing account
      await db.email_accounts.update({
        where: { id: existing.id },
        data: {
          provider: "gmail_api",
          oauth_access_token_enc: accessTokenEnc,
          oauth_refresh_token_enc: refreshTokenEnc,
          oauth_expires_at: expiresAt,
          oauth_scopes: scopesList,
          status: "active",
          last_error: null,
        },
      });

      logger.info({ email: emailLower, accountId: existing.id }, "Google Gmail account reconnected successfully");
      return NextResponse.redirect(
        new URL(`${returnTo}?reconnected=true&email=${encodeURIComponent(emailLower)}`, appUrl)
      );
    }

    // New account creation: Check plan limits
    await assertLimit(effectiveUserId, "max_email_accounts", 1);

    const created = await db.email_accounts.create({
      data: {
        user_id: effectiveUserId,
        kind: "personal",
        provider: "gmail_api",
        label: tokens.name ? `${tokens.name} (Gmail)` : `Gmail (${emailLower})`,
        from_name: tokens.name || emailLower.split("@")[0],
        from_email: emailLower,
        reply_to: emailLower,
        oauth_access_token_enc: accessTokenEnc,
        oauth_refresh_token_enc: refreshTokenEnc,
        oauth_expires_at: expiresAt,
        oauth_scopes: scopesList,
        hourly_limit: 25,
        daily_limit: 150,
        gap_seconds: 120,
        timezone: "UTC",
        warmup_enabled: false,
        status: "active",
      },
    });

    logger.info({ email: emailLower, accountId: created.id }, "Google Gmail outreach account linked successfully");
    return NextResponse.redirect(
      new URL(`${returnTo}?connected=true&email=${encodeURIComponent(emailLower)}`, appUrl)
    );
  } catch (err: any) {
    logger.error({ err }, "Google outreach OAuth callback exchange error");
    return NextResponse.redirect(
      new URL(
        `${returnTo}?error=${encodeURIComponent(err.message || "Failed to link Google account")}`,
        appUrl
      )
    );
  }
}
