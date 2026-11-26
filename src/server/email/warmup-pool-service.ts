import crypto from "node:crypto";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { getEffectiveAccountDailyLimit } from "@/server/email/account-service";
import { dispatchEmailTransport } from "@/server/email/sending-engine";

export const WARMUP_HEADER = "X-LeadReachAI-Warmup";
export const WARMUP_ID_HEADER = "X-LeadReachAI-Warmup-Id";
export const WARMUP_REPLY_HEADER = "X-LeadReachAI-Warmup-Reply";

const WARMUP_TEMPLATES: Array<{ subject: string; body: string; reply: string }> = [
  {
    subject: "Quick check-in on Tuesday sync",
    body: "Hey team,\n\nJust checking if our notes for this week's sync look good on your end. Let me know when you have a minute.\n\nBest,\nAlex",
    reply: "Looks great on my end! Let's stick to the agenda and catch up tomorrow.",
  },
  {
    subject: "Updated Q4 schedule overview",
    body: "Hi there,\n\nWanted to share a quick reminder that our timeline review is penciled in for Thursday afternoon.\n\nThanks!",
    reply: "Got it, thanks for the heads-up! Thursday afternoon works cleanly for me.",
  },
  {
    subject: "Deliverable feedback thread",
    body: "Hello,\n\nDid you get a chance to glance over the draft outline from earlier today? Happy to adjust any sections.\n\nCheers",
    reply: "Yes, reviewed it earlier — everything reads clearly. No changes needed right now.",
  },
  {
    subject: "Follow-up on internal onboarding docs",
    body: "Hi,\n\nSharing a quick note to confirm the shared checklist is ready whenever you need access.\n\nRegards",
    reply: "Confirmed, I can see it clearly on my side. Appreciate the update!",
  },
];

function getHeaderValue(headers: any, key: string): string {
  if (!headers) return "";
  const lowerKey = key.toLowerCase();
  if (typeof headers.get === "function") {
    const val = headers.get(lowerKey) ?? headers.get(key);
    return val ? String(val).trim() : "";
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerKey && v != null) {
      return String(v).trim();
    }
  }
  return "";
}

export function isWarmupMessageHeaders(headers: any): boolean {
  const w = getHeaderValue(headers, WARMUP_HEADER).toLowerCase();
  const r = getHeaderValue(headers, WARMUP_REPLY_HEADER).toLowerCase();
  return w === "true" || w === "1" || r === "true" || r === "1";
}

export async function getCombinedAccountSendCounts(
  accountId: string,
  now: Date = new Date()
): Promise<{ sentToday: number; sentLastHour: number }> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const [outreachToday, outreachHour, warmupToday, warmupHour] = await Promise.all([
    db.email_messages.count({
      where: {
        email_account_id: accountId,
        direction: "out",
        status: "sent",
        sent_at: { gte: startOfDay },
      },
    }),
    db.email_messages.count({
      where: {
        email_account_id: accountId,
        direction: "out",
        status: "sent",
        sent_at: { gte: oneHourAgo },
      },
    }),
    db.warmup_logs.count({
      where: {
        from_account_id: accountId,
        status: { in: ["sent", "replied"] },
        sent_at: { gte: startOfDay },
      },
    }),
    db.warmup_logs.count({
      where: {
        from_account_id: accountId,
        status: { in: ["sent", "replied"] },
        sent_at: { gte: oneHourAgo },
      },
    }),
  ]);

  return {
    sentToday: outreachToday + warmupToday,
    sentLastHour: outreachHour + warmupHour,
  };
}

function accountHasImap(account: any): boolean {
  return Boolean(account?.imap_host && (account?.imap_password_enc || account?.imap_username));
}

export function pickWarmupReceiver(sender: any, pool: any[], seedIndex = 0): any | null {
  const candidates = pool.filter((a) => a.id !== sender.id);
  if (candidates.length === 0) return null;
  const imapCapable = candidates.filter((a) => accountHasImap(a));
  const preferred = imapCapable.length > 0 ? imapCapable : candidates;
  return preferred[seedIndex % preferred.length];
}

export interface SelfWarmupTickResult {
  usersProcessed: number;
  usersSkippedBelowMin: number;
  emailsSent: number;
  throttled: number;
  failed: number;
}

export async function runSelfWarmupTick(
  transportFn: typeof dispatchEmailTransport = dispatchEmailTransport,
  now: Date = new Date()
): Promise<SelfWarmupTickResult> {
  const maxPerTick = Math.min(
    50,
    Math.max(1, Number(process.env.SELF_WARMUP_MAX_PER_TICK || "5"))
  );

  const warmupAccounts = await db.email_accounts.findMany({
    where: {
      status: "active",
      warmup_enabled: true,
    },
    select: {
      id: true,
      user_id: true,
      provider: true,
      from_name: true,
      from_email: true,
      hourly_limit: true,
      daily_limit: true,
      warmup_enabled: true,
      warmup_day: true,
      warmup_start_limit: true,
      warmup_daily_increment: true,
      warmup_max_limit: true,
      imap_host: true,
      imap_username: true,
      imap_password_enc: true,
    },
  });

  // Group strictly per user_id — accounts ONLY warm up within the same user's own pool
  const byUser = new Map<string, any[]>();
  for (const acc of warmupAccounts) {
    const arr = byUser.get(acc.user_id) || [];
    arr.push(acc);
    byUser.set(acc.user_id, arr);
  }

  let usersProcessed = 0;
  let usersSkippedBelowMin = 0;
  let emailsSent = 0;
  let throttled = 0;
  let failed = 0;

  for (const [userId, pool] of byUser.entries()) {
    if (pool.length < 2) {
      usersSkippedBelowMin++;
      continue;
    }

    usersProcessed++;
    let userTickSends = 0;

    for (let i = 0; i < pool.length && userTickSends < maxPerTick; i++) {
      const fromAccount = pool[i];
      const toAccount = pickWarmupReceiver(fromAccount, pool, i + Math.floor(now.getMinutes()));
      if (!toAccount) continue;

      const dailyCap = getEffectiveAccountDailyLimit(fromAccount);
      const hourlyCap = Math.min(25, Math.max(1, Number(fromAccount.hourly_limit || 25)));
      const { sentToday, sentLastHour } = await getCombinedAccountSendCounts(fromAccount.id, now);

      if (sentToday >= dailyCap || sentLastHour >= hourlyCap) {
        throttled++;
        continue;
      }

      const logId = crypto.randomUUID();
      const tpl = WARMUP_TEMPLATES[(i + now.getDate() + now.getHours()) % WARMUP_TEMPLATES.length];
      const senderDomain = fromAccount.from_email.split("@")[1] || "leadreach.ai";
      const explicitMessageId = `<warmup-${logId}@${senderDomain}>`;
      const subject = `${tpl.subject} #${logId.slice(0, 6)}`;
      const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#111827;">${tpl.body
        .split("\n\n")
        .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
        .join("")}</div>`;

      try {
        const res = await transportFn({
          account: fromAccount,
          to: toAccount.from_email,
          subject,
          text: tpl.body,
          html,
          explicitMessageId,
          headers: {
            [WARMUP_HEADER]: "true",
            [WARMUP_ID_HEADER]: logId,
          },
        });

        await db.warmup_logs.create({
          data: {
            id: logId,
            user_id: userId,
            from_account_id: fromAccount.id,
            to_account_id: toAccount.id,
            message_id: res.messageId || explicitMessageId,
            subject,
            status: "sent",
            sent_at: now,
          },
        });

        emailsSent++;
        userTickSends++;
      } catch (err: any) {
        failed++;
        logger.warn(
          { userId, fromAccountId: fromAccount.id, toAccountId: toAccount.id, err: err?.message },
          "Self warm-up send failed"
        );
        await db.warmup_logs
          .create({
            data: {
              id: logId,
              user_id: userId,
              from_account_id: fromAccount.id,
              to_account_id: toAccount.id,
              message_id: explicitMessageId,
              subject,
              status: "failed",
              error: err?.message || "Warm-up transport failed",
              sent_at: now,
            },
          })
          .catch(() => null);
      }
    }
  }

  return {
    usersProcessed,
    usersSkippedBelowMin,
    emailsSent,
    throttled,
    failed,
  };
}

export async function handleIncomingWarmupEmail(
  input: {
    receivingAccount: any;
    fromAddress: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    subject?: string;
    headers: any;
  },
  transportFn: typeof dispatchEmailTransport = dispatchEmailTransport
): Promise<{ handled: boolean; replied: boolean; reason?: string }> {
  if (!isWarmupMessageHeaders(input.headers)) {
    return { handled: false, replied: false };
  }

  const isAlreadyReply =
    getHeaderValue(input.headers, WARMUP_REPLY_HEADER).toLowerCase() === "true" ||
    getHeaderValue(input.headers, WARMUP_REPLY_HEADER) === "1";

  // CRITICAL LOOP GUARD: Never reply to an existing warm-up reply
  if (isAlreadyReply) {
    return { handled: true, replied: false, reason: "already_reply" };
  }

  const warmupId = getHeaderValue(input.headers, WARMUP_ID_HEADER);
  const candidateMsgIds = [
    input.messageId,
    input.inReplyTo,
    ...(input.references || []),
  ].filter((v): v is string => Boolean(v && String(v).trim()));

  let log: any = null;
  if (warmupId) {
    log = await db.warmup_logs.findFirst({
      where: {
        id: warmupId,
        user_id: input.receivingAccount.user_id,
      },
    });
  }
  if (!log && candidateMsgIds.length > 0) {
    log = await db.warmup_logs.findFirst({
      where: {
        user_id: input.receivingAccount.user_id,
        message_id: { in: candidateMsgIds },
      },
    });
  }

  if (!log) {
    return { handled: true, replied: false, reason: "log_not_found" };
  }

  // CRITICAL LOOP GUARD: Only reply once when status === "sent"
  if (log.status !== "sent") {
    return { handled: true, replied: false, reason: "already_replied" };
  }

  // Rate limit check on the replying account
  const now = new Date();
  const dailyCap = getEffectiveAccountDailyLimit(input.receivingAccount);
  const hourlyCap = Math.min(25, Math.max(1, Number(input.receivingAccount.hourly_limit || 25)));
  const { sentToday, sentLastHour } = await getCombinedAccountSendCounts(
    input.receivingAccount.id,
    now
  );
  if (sentToday >= dailyCap || sentLastHour >= hourlyCap) {
    return { handled: true, replied: false, reason: "rate_limited" };
  }

  const senderDomain = input.receivingAccount.from_email?.split("@")[1] || "leadreach.ai";
  const replyMessageId = `<warmup-reply-${log.id}@${senderDomain}>`;

  // Atomic transition sent -> replied before sending so concurrent pollers cannot double-reply
  const claimed = await db.warmup_logs.updateMany({
    where: {
      id: log.id,
      status: "sent",
    },
    data: {
      status: "replied",
      replied_at: now,
      reply_message_id: replyMessageId,
    },
  });
  if (!claimed || claimed.count === 0) {
    return { handled: true, replied: false, reason: "already_replied" };
  }

  const tpl = WARMUP_TEMPLATES[0];
  const replySubject = (input.subject || log.subject || "Check-in").startsWith("Re:")
    ? input.subject || log.subject
    : `Re: ${log.subject || input.subject || "Check-in"}`;
  const replyHtml = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#111827;"><p>${tpl.reply}</p></div>`;

  try {
    await transportFn({
      account: input.receivingAccount,
      to: input.fromAddress,
      subject: replySubject,
      text: tpl.reply,
      html: replyHtml,
      explicitMessageId: replyMessageId,
      inReplyTo: log.message_id || input.messageId,
      references: log.message_id || input.messageId,
      headers: {
        [WARMUP_HEADER]: "true",
        [WARMUP_REPLY_HEADER]: "true",
        [WARMUP_ID_HEADER]: log.id,
      },
    });
    return { handled: true, replied: true };
  } catch (err: any) {
    logger.warn(
      { warmupLogId: log.id, accountId: input.receivingAccount.id, err: err?.message },
      "Failed to send single self warm-up reply"
    );
    return { handled: true, replied: false, reason: "reply_transport_failed" };
  }
}

export async function listUserWarmupLogs(
  userId: string,
  opts: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, Number(opts.page || 1));
  const limit = Math.min(50, Math.max(1, Number(opts.limit || 20)));
  const skip = (page - 1) * limit;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [items, total, accounts, sentToday, repliedToday] = await Promise.all([
    db.warmup_logs.findMany({
      where: { user_id: userId },
      orderBy: { sent_at: "desc" },
      skip,
      take: limit,
      include: {
        from_account: { select: { id: true, from_email: true, label: true } },
        to_account: { select: { id: true, from_email: true, label: true } },
      },
    }),
    db.warmup_logs.count({ where: { user_id: userId } }),
    db.email_accounts.findMany({
      where: { user_id: userId, status: "active", warmup_enabled: true },
      select: { id: true, imap_host: true, imap_password_enc: true },
    }),
    db.warmup_logs.count({
      where: { user_id: userId, sent_at: { gte: startOfDay }, status: { in: ["sent", "replied"] } },
    }),
    db.warmup_logs.count({
      where: { user_id: userId, replied_at: { gte: startOfDay }, status: "replied" },
    }),
  ]);

  const poolCount = accounts.length;
  const imapCapableCount = accounts.filter(
    (a: any) => Boolean(a.imap_host && a.imap_password_enc)
  ).length;

  return {
    items,
    total,
    page,
    limit,
    summary: {
      poolCount,
      imapCapableCount,
      poolActive: poolCount >= 2,
      sentToday,
      repliedToday,
    },
  };
}
