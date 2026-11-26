import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { isGmailDailyLimitError } from "@/server/email/daily-capacity";

export const MIN_BOUNCE_PAUSE_SAMPLE_SIZE = 30;
export const HARD_BOUNCE_PAUSE_RATE_THRESHOLD = 0.02; // Strictly > 2%
export const MAX_CONSECUTIVE_SMTP_AUTH_FAILURES = 3;

const authLockTails = new Map<string, Promise<void>>();

async function withAccountAuthLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const previous = authLockTails.get(accountId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((res) => {
    release = res;
  });
  const nextTail = previous.then(() => current, () => current);
  authLockTails.set(accountId, nextTail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (authLockTails.get(accountId) === nextTail) {
      authLockTails.delete(accountId);
    }
  }
}

export function isSmtpAuthFailureError(errorMsg = ""): boolean {
  const msg = String(errorMsg);
  return (
    msg.includes("EAUTH") ||
    msg.includes("BadCredentials") ||
    /\b535\b/.test(msg) ||
    /\b534\b/.test(msg) ||
    /Invalid login/i.test(msg) ||
    /Username and Password not accepted/i.test(msg) ||
    msg.includes("reconnection required") ||
    msg.includes("invalid_grant") ||
    msg.includes("Token has been expired or revoked")
  );
}

/**
 * Recognizes synchronous permanent SMTP hard-bounce rejections (550 5.1.1, unknown user, etc.),
 * explicitly excluding Gmail rate-limit errors (550 5.4.5) and auth errors (535).
 */
export function isPermanentHardBounceSmtpError(errorMsg = ""): boolean {
  const msg = String(errorMsg);
  if (!msg || isGmailDailyLimitError(msg) || isSmtpAuthFailureError(msg)) {
    return false;
  }

  return (
    /550[- ]5\.1\.[0-9]/.test(msg) ||
    /(?:550|551|552|553|554)[- ].*(?:user unknown|no such user|does not exist|mailbox unavailable|unknown user|address rejected|recipient address rejected|invalid recipient|mailbox not found|bad destination mailbox)/i.test(
      msg
    )
  );
}

/**
 * Computes 7-day rolling hard-bounce rate for an account.
 * Auto-pauses ONLY that account when bounce rate > 2% with >= 30 sends.
 */
export async function evaluateAccountBouncePause(
  accountId: string,
  now: Date = new Date()
): Promise<{
  paused: boolean;
  bounceCount: number;
  totalSends: number;
  bounceRate: number;
  reason?: string;
}> {
  const account = await db.email_accounts.findUnique({ where: { id: accountId } });
  if (!account) {
    return { paused: false, bounceCount: 0, totalSends: 0, bounceRate: 0 };
  }

  const windowStart = new Date(now.getTime() - 7 * 86400 * 1000);

  const sentMessages = db.email_messages?.findMany
    ? await db.email_messages.findMany({
        where: {
          email_account_id: accountId,
          direction: "out",
          kind: { in: ["initial", "followup"] },
          status: "sent",
          sent_at: { gte: windowStart, lte: now },
        },
        select: { recipient_id: true, sent_at: true },
      })
    : [];

  const bouncedRecipients = db.campaign_recipients?.findMany
    ? await db.campaign_recipients.findMany({
        where: {
          assigned_account_id: accountId,
          status: "bounced",
        },
        select: { id: true, last_sent_at: true, sent_at: true, updated_at: true, created_at: true },
      })
    : [];

  const bouncedInWindow = (bouncedRecipients || []).filter((r: any) => {
    const ts = new Date(r.last_sent_at || r.sent_at || r.updated_at || r.created_at || 0).getTime();
    return ts >= windowStart.getTime() && ts <= now.getTime();
  });

  const sentRecipientIds = new Set(
    (sentMessages || []).map((m: any) => m.recipient_id).filter(Boolean)
  );
  let syncBouncesOutsideSent = 0;
  for (const r of bouncedInWindow) {
    if (!sentRecipientIds.has(r.id)) {
      syncBouncesOutsideSent++;
    }
  }

  const bounceCount = bouncedInWindow.length;
  const totalSends = (sentMessages || []).length + syncBouncesOutsideSent;
  const bounceRate = totalSends > 0 ? bounceCount / totalSends : 0;

  if (totalSends < MIN_BOUNCE_PAUSE_SAMPLE_SIZE || bounceRate <= HARD_BOUNCE_PAUSE_RATE_THRESHOLD) {
    return { paused: false, bounceCount, totalSends, bounceRate };
  }

  const pctLabel = (bounceRate * 100).toFixed(1);
  const reason = `Paused automatically due to high 7-day hard-bounce rate: ${pctLabel}% (${bounceCount} bounces across ${totalSends} sends). Review list quality and manually resume when ready.`;

  await db.email_accounts.update({
    where: { id: accountId },
    data: {
      status: "paused_deliverability",
      health_status: "paused",
      deliverability_pause_reason: reason,
      deliverability_paused_at: now,
      last_error: reason,
    },
  });

  logger.warn(
    { accountId, bounceCount, totalSends, bounceRate: pctLabel },
    "Auto-paused email account due to >2% hard-bounce rate over 7 days"
  );

  return { paused: true, bounceCount, totalSends, bounceRate, reason };
}

/**
 * Records a recipient hard bounce, permanently suppresses the address for future campaigns,
 * and evaluates whether the sending account crossed the >2% bounce auto-pause threshold.
 */
export async function recordHardBounceAndSuppress(params: {
  userId: string;
  accountId?: string | null;
  recipientId: string;
  campaignId?: string | null;
  email: string;
  reason?: string;
  now?: Date;
}) {
  const now = params.now || new Date();
  const cleanEmail = params.email.toLowerCase().trim();

  await db.campaign_recipients.update({
    where: { id: params.recipientId },
    data: {
      status: "bounced",
      error: params.reason || "Delivery failed / bounced",
      next_followup_at: null,
    },
  });

  if (cleanEmail) {
    const existingSup = await db.suppressions.findFirst({
      where: { user_id: params.userId, email: cleanEmail },
    });
    if (!existingSup) {
      await db.suppressions.create({
        data: {
          user_id: params.userId,
          email: cleanEmail,
          reason: "bounced",
          source_campaign_id: params.campaignId || undefined,
        },
      });
    }
  }

  if (params.accountId) {
    return evaluateAccountBouncePause(params.accountId, now);
  }
  return { paused: false, bounceCount: 0, totalSends: 0, bounceRate: 0 };
}

/**
 * Increments consecutive SMTP auth failure counter on an account.
 * On the 3rd consecutive auth failure, pauses ONLY that account for manual recovery.
 */
export async function recordAccountAuthFailure(
  accountId: string,
  errorMsg: string,
  now: Date = new Date()
): Promise<{ paused: boolean; consecutiveFailures: number; reason?: string }> {
  return withAccountAuthLock(accountId, async () => {
    const account = await db.email_accounts.findUnique({ where: { id: accountId } });
    if (!account) {
      return { paused: false, consecutiveFailures: 0 };
    }

    const nextFailures = Math.max(0, Number(account.consecutive_smtp_auth_failures) || 0) + 1;

    if (nextFailures >= MAX_CONSECUTIVE_SMTP_AUTH_FAILURES) {
      const reason = `Paused automatically after ${nextFailures} consecutive SMTP authentication failures (${errorMsg}). Verify credentials and manually resume.`;
      await db.email_accounts.update({
        where: { id: accountId },
        data: {
          consecutive_smtp_auth_failures: nextFailures,
          status: "paused_deliverability",
          health_status: "paused",
          deliverability_pause_reason: reason,
          deliverability_paused_at: now,
          last_error: reason,
        },
      });
      logger.warn(
        { accountId, consecutiveFailures: nextFailures },
        "Auto-paused email account after 3 consecutive SMTP auth failures"
      );
      return { paused: true, consecutiveFailures: nextFailures, reason };
    }

    await db.email_accounts.update({
      where: { id: accountId },
      data: {
        consecutive_smtp_auth_failures: nextFailures,
        last_error: errorMsg,
      },
    });
    logger.warn(
      { accountId, consecutiveFailures: nextFailures },
      "Recorded transient SMTP auth failure on email account"
    );
    return { paused: false, consecutiveFailures: nextFailures };
  });
}

export async function resetAccountAuthFailures(accountId: string) {
  await withAccountAuthLock(accountId, async () => {
    const account = await db.email_accounts.findUnique({
      where: { id: accountId },
      select: { id: true, consecutive_smtp_auth_failures: true },
    });
    if (!account || !account.consecutive_smtp_auth_failures) return;
    await db.email_accounts.update({
      where: { id: accountId },
      data: { consecutive_smtp_auth_failures: 0 },
    });
  });
}

/**
 * Manually resumes a deliverability-paused or attention-needed email account.
 * Clears auth failure streak and pause metadata; preserves Task 6 health/limits without auto-raising caps.
 */
export async function resumePausedEmailAccount(userId: string, accountId: string) {
  const existing = await db.email_accounts.findFirst({
    where: { id: accountId, user_id: userId },
  });
  if (!existing) {
    throw new Error("Email account not found");
  }

  const nextHealthStatus =
    existing.health_status === "paused" ? "holding" : existing.health_status || "healthy";

  const updated = await db.email_accounts.update({
    where: { id: accountId },
    data: {
      status: "active",
      consecutive_smtp_auth_failures: 0,
      deliverability_pause_reason: null,
      deliverability_paused_at: null,
      last_error: null,
      health_status: nextHealthStatus,
    },
  });

  logger.info(
    { accountId, userId, previousStatus: existing.status },
    "Manually resumed paused email account"
  );

  return updated;
}
