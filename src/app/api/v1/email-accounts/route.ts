import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import {
  listEmailAccounts,
  createEmailAccount,
  testSmtpConnection,
  testImapConnection,
  deriveImapFromSmtp,
} from "@/server/email/account-service";
import { assertLimit } from "@/server/billing/limits";
import { assertTrialActive, isTrialExpiredError } from "@/server/billing/trial";
import { trialExpiredJsonResponse } from "@/server/billing/trial-response";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { z } from "zod";

const createAccountSchema = z.object({
  // Required: the 5 core fields from the simplified modal
  from_email: z.string().email("Valid sender email is required"),
  smtp_host: z.string().min(1, "SMTP host is required"),
  smtp_port: z.coerce.number().min(1).max(65535),
  smtp_security: z.enum(["ssl", "tls", "starttls", "none"]).default("ssl"),
  smtp_password: z.string().min(1, "Password is required"),

  // smtp_username defaults to from_email if omitted
  smtp_username: z.string().optional(),

  // Optional identity (populated after save in Account Settings drawer)
  label: z.string().optional(),
  from_name: z.string().optional(),
  senderName: z.string().optional(),
  reply_to: z.string().email("Valid reply-to email").optional().or(z.literal("")),
  reply_inbox_account_id: z.string().uuid("Valid UUID required").optional().or(z.literal("")),
  signature: z.string().optional(),

  // IMAP — fully optional; auto-derived from SMTP if omitted
  imap_host: z.string().optional(),
  imap_port: z.coerce.number().min(1).max(65535).optional(),
  imap_security: z.enum(["ssl", "tls", "starttls", "none"]).optional(),
  imap_username: z.string().optional().or(z.literal("")),
  imap_password: z.string().optional().or(z.literal("")),

  // Speed & safety — Safe Preset defaults
  hourly_limit: z.coerce.number().min(1).max(25).default(25),
  daily_limit: z.coerce.number().min(1).max(500).default(75),
  gap_seconds: z.coerce.number().min(30).max(3600).default(120),
  min_gap_seconds: z.coerce.number().min(30).max(3600).default(120),
  max_gap_seconds: z.coerce.number().min(30).max(3600).default(300),
  timezone: z.string().default("UTC"),

  // Warmup — Safe Preset: enabled by default
  warmup_enabled: z.boolean().default(true),
  warmup_day: z.coerce.number().min(1).default(1),
  warmup_start_limit: z.coerce.number().min(1).max(50).default(10),
  warmup_daily_increment: z.coerce.number().min(1).max(20).default(5),
  warmup_max_limit: z.coerce.number().min(10).max(500).default(50),
  workspace_tier: z.enum(["trial", "paid"]).optional(),
  user_daily_limit: z.coerce.number().int().min(5).max(500).nullable().optional(),

  validate_before_save: z.boolean().default(false),
});

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const accounts = await listEmailAccounts(session.user.id);
    return NextResponse.json({ data: accounts });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to list email accounts" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await assertTrialActive(session.user.id);
  } catch (err) {
    if (isTrialExpiredError(err)) {
      return trialExpiredJsonResponse(err);
    }
    throw err;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createAccountSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Validation failed" }, { status: 400 });
  }

  const input = parsed.data;
  const normalizedEmail = input.from_email.toLowerCase().trim();

  // Check duplicate email for this user before quota/create
  const existingAccount = await db.email_accounts.findFirst({
    where: { user_id: session.user.id, from_email: normalizedEmail },
    select: { id: true },
  });
  if (existingAccount) {
    return NextResponse.json(
      {
        error: "This email account is already connected.",
        code: "ACCOUNT_ALREADY_EXISTS",
        existingAccountId: existingAccount.id,
      },
      { status: 409 }
    );
  }

  // Derive defaults the user didn't explicitly provide
  const smtpUsername = (input.smtp_username || normalizedEmail).trim();
  const emailPrefix = normalizedEmail.split("@")[0] || "Inbox";
  const accountLabel = input.label?.trim() || `${emailPrefix} Inbox`;
  const senderName =
    input.senderName?.trim() ||
    input.from_name?.trim() ||
    session.user.name?.trim() ||
    emailPrefix;

  // Auto-derive IMAP from SMTP host if not explicitly provided
  const derived = deriveImapFromSmtp(input.smtp_host);
  const imapHost = input.imap_host?.trim() || derived.host;
  const imapPort = input.imap_port || derived.port;
  const imapSecurity = input.imap_security || derived.security;
  const imapUsername = (input.imap_username || smtpUsername).trim();
  const imapPassword = input.imap_password || input.smtp_password;

  // Enforce plan quota for email accounts
  try {
    await assertLimit(session.user.id, "max_email_accounts", 1);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 429 });
  }

  // Live validation of SMTP connection before saving (sending must work)
  if (input.validate_before_save) {
    const smtpCheck = await testSmtpConnection({
      host: input.smtp_host,
      port: input.smtp_port,
      security: input.smtp_security,
      username: smtpUsername,
      password: input.smtp_password,
    });
    if (!smtpCheck.ok) {
      return NextResponse.json({ error: `SMTP Check Failed: ${smtpCheck.error}` }, { status: 400 });
    }

    // Attempt IMAP check for warning logging, but do not block send-only accounts
    try {
      const imapCheck = await testImapConnection({
        host: imapHost,
        port: imapPort,
        security: imapSecurity,
        username: imapUsername,
        password: imapPassword,
      });
      if (!imapCheck.ok) {
        logger.warn({ host: imapHost, err: imapCheck.error }, "IMAP check failed on save; creating account in send-only mode");
      }
    } catch (e) {
      logger.warn({ err: e }, "IMAP check exception on save; proceeding with send-only account");
    }
  }

  try {
    const account = await createEmailAccount(session.user.id, {
      label: accountLabel,
      from_name: senderName,
      from_email: input.from_email,
      reply_to: input.reply_to || undefined,
      reply_inbox_account_id: input.reply_inbox_account_id || undefined,
      signature: input.signature || undefined,
      smtp_host: input.smtp_host,
      smtp_port: input.smtp_port,
      smtp_security: input.smtp_security,
      smtp_username: smtpUsername,
      smtp_password: input.smtp_password,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_security: imapSecurity,
      imap_username: imapUsername,
      imap_password: imapPassword,
      hourly_limit: input.hourly_limit,
      daily_limit: input.daily_limit,
      gap_seconds: input.gap_seconds,
      min_gap_seconds: input.min_gap_seconds,
      max_gap_seconds: input.max_gap_seconds,
      timezone: input.timezone,
      warmup_enabled: input.warmup_enabled,
      warmup_day: input.warmup_day,
      warmup_start_limit: input.warmup_start_limit,
      warmup_daily_increment: input.warmup_daily_increment,
      warmup_max_limit: input.warmup_max_limit,
      workspace_tier: input.workspace_tier,
      user_daily_limit: input.user_daily_limit,
    });
    return NextResponse.json({ data: account }, { status: 201 });
  } catch (err: any) {
    const errCode = err?.code || err?.cause?.code;
    const rawMsg = String(err?.message || "");
    const isUniqueConflict =
      errCode === "P2002" ||
      rawMsg.includes("Unique constraint") ||
      rawMsg.includes("email_accounts_user_id_from_email_key");

    if (isUniqueConflict) {
      let existingId: string | undefined;
      try {
        const dup = await db.email_accounts.findFirst({
          where: { user_id: session.user.id, from_email: normalizedEmail },
          select: { id: true },
        });
        existingId = dup?.id;
      } catch {}

      return NextResponse.json(
        {
          error: "This email account is already connected.",
          code: "ACCOUNT_ALREADY_EXISTS",
          ...(existingId ? { existingAccountId: existingId } : {}),
        },
        { status: 409 }
      );
    }

    logger.error(
      { err: rawMsg, code: errCode, userId: session.user.id },
      "Failed to create email account"
    );
    const isPrismaErr =
      Boolean(errCode && String(errCode).startsWith("P")) ||
      String(err?.name || "").includes("Prisma") ||
      rawMsg.toLowerCase().includes("prisma");

    return NextResponse.json(
      {
        error: isPrismaErr
          ? "Could not save email account. Please verify your settings and try again."
          : rawMsg || "Failed to create email account",
      },
      { status: 500 }
    );
  }
}
