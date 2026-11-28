import { db } from "@/server/db";
import { getAppUrl, getConfig } from "@/server/config";
import { isAdminRole } from "@/server/auth/permissions";
import { sendSystemMail } from "@/server/email/system-mailer";
import { logger } from "@/server/logger";

const DAY_MS = 86_400_000;

export type TrialState = "active" | "expired" | "not_applicable";

export interface TrialStatus {
  status: TrialState;
  daysLeft: number;
  endsAt: string | null;
  trialDaysConfigured: number;
  isExempt: boolean;
  subscriptionId?: string;
}

export class TrialExpiredError extends Error {
  status = 402;
  code = "trial_expired" as const;
  upgradeUrl = "/app/settings/billing" as const;
  endsAt: string | null;

  constructor(endsAt?: Date | string | null) {
    super(
      "Your free trial has ended. Please upgrade to a paid plan at /app/settings/billing to continue."
    );
    this.name = "TrialExpiredError";
    this.endsAt = endsAt ? new Date(endsAt).toISOString() : null;
  }
}

export function isTrialExpiredError(err: unknown): err is TrialExpiredError {
  return (
    err instanceof TrialExpiredError ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "trial_expired")
  );
}

/**
 * Read TRIAL_DAYS from admin config, honoring 0 as "no trial" instead of falling back to 14.
 */
export async function getConfiguredTrialDays(): Promise<number> {
  const raw = await getConfig("TRIAL_DAYS").catch(() => null);
  if (raw === null || raw === undefined || raw === "") {
    return 14;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 14;
  }
  return parsed;
}

/**
 * Ensure a Free plan record exists so trial subscriptions can reference its plan_id.
 */
export async function ensureFreePlanRecord() {
  const existing = await db.plans.findUnique({ where: { slug: "free" } }).catch(() => null);
  if (existing) return existing;

  try {
    return await db.plans.create({
      data: {
        name: "Free Tier",
        slug: "free",
        monthly_price: 0,
        yearly_price: 0,
        currency: "USD",
        is_active: true,
        features: [
          "100 Leads / month",
          "30 Social Posts / month",
          "100 Outreach Emails / month",
          "1 Email Inbox",
          "2 Social Accounts",
          "2 Active Campaigns",
        ],
        monthly_leads: 100,
        monthly_social_posts: 30,
        monthly_outreach_emails: 100,
        daily_outreach_emails: 50,
        monthly_ai_outreach_emails: 50,
        max_social_accounts: 2,
        max_email_accounts: 1,
        max_campaigns: 2,
      },
    });
  } catch {
    return await db.plans.findUnique({ where: { slug: "free" } }).catch(() => null);
  }
}

/**
 * Provision a free-trial subscription for a newly signed-up user.
 * Reuses `subscriptions` (`status: "trialing"`, `provider: "trial"`).
 */
export async function startFreeTrialForUser(
  userId: string,
  opts: { now?: Date; trialDays?: number } = {}
) {
  if (!userId) return null;

  const user = await db.users.findUnique({
    where: { id: userId },
    select: { id: true, role: true, plan: true, plan_id: true, trial_exempt: true },
  });
  if (!user) return null;
  if (isAdminRole(user.role) || user.trial_exempt) return null;
  if (user.plan && user.plan !== "free") return null;

  const existingSub = await db.subscriptions.findFirst({
    where: {
      user_id: userId,
      status: { in: ["trialing", "active", "past_due"] },
    },
  });
  if (existingSub) return existingSub;

  const existingTrial = await db.subscriptions.findFirst({
    where: { user_id: userId, provider: "trial" },
  });
  if (existingTrial) return existingTrial;

  const freePlan = await ensureFreePlanRecord();
  if (!freePlan) {
    logger.warn({ userId }, "Unable to create trial subscription: free plan record missing");
    return null;
  }

  const now = opts.now ?? new Date();
  const trialDays = opts.trialDays ?? (await getConfiguredTrialDays());
  const endsAt = new Date(now.getTime() + Math.max(0, trialDays) * DAY_MS);

  const sub = await db.subscriptions.create({
    data: {
      user_id: userId,
      plan_id: freePlan.id,
      status: "trialing",
      current_period_start: now,
      current_period_end: endsAt,
      cancel_at_period_end: false,
      provider: "trial",
      provider_subscription_id: `trial_${userId}`,
    },
  });

  if (!user.plan_id) {
    await db.users
      .update({
        where: { id: userId },
        data: { plan: "free", plan_id: freePlan.id },
      })
      .catch(() => null);
  }

  return sub;
}

/**
 * Evaluate a user's free trial status.
 * Staff/admin, trial-exempt users, and paid-plan users always resolve to `not_applicable`.
 */
export async function getTrialStatus(
  userId: string,
  now: Date = new Date()
): Promise<TrialStatus> {
  const trialDaysConfigured = await getConfiguredTrialDays();

  if (!userId || !db.users?.findUnique) {
    return {
      status: "not_applicable",
      daysLeft: 0,
      endsAt: null,
      trialDaysConfigured,
      isExempt: false,
    };
  }

  const user = await db.users.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      plan: true,
      trial_exempt: true,
    },
  });

  if (!user) {
    return {
      status: "not_applicable",
      daysLeft: 0,
      endsAt: null,
      trialDaysConfigured,
      isExempt: false,
    };
  }

  if (isAdminRole(user.role) || user.trial_exempt) {
    return {
      status: "not_applicable",
      daysLeft: 0,
      endsAt: null,
      trialDaysConfigured,
      isExempt: Boolean(user.trial_exempt),
    };
  }

  if (user.plan && user.plan !== "free") {
    return {
      status: "not_applicable",
      daysLeft: 0,
      endsAt: null,
      trialDaysConfigured,
      isExempt: false,
    };
  }

  const subs = await db.subscriptions
    .findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 10,
    })
    .catch(() => []);

  const trialSub =
    subs.find((s: any) => s.status === "trialing") ||
    subs.find((s: any) => s.provider === "trial");

  if (!trialSub) {
    return {
      status: "not_applicable",
      daysLeft: 0,
      endsAt: null,
      trialDaysConfigured,
      isExempt: false,
    };
  }

  const endsAtDate = new Date(trialSub.current_period_end);
  const msLeft = endsAtDate.getTime() - now.getTime();
  const isActive = trialSub.status === "trialing" && msLeft > 0;

  if (isActive) {
    return {
      status: "active",
      daysLeft: Math.max(1, Math.ceil(msLeft / DAY_MS)),
      endsAt: endsAtDate.toISOString(),
      trialDaysConfigured,
      isExempt: false,
      subscriptionId: trialSub.id,
    };
  }

  return {
    status: "expired",
    daysLeft: 0,
    endsAt: endsAtDate.toISOString(),
    trialDaysConfigured,
    isExempt: false,
    subscriptionId: trialSub.id,
  };
}

/**
 * Throw `TrialExpiredError` if the user's trial has expired.
 */
export async function assertTrialActive(userId: string): Promise<TrialStatus> {
  const status = await getTrialStatus(userId);
  if (status.status === "expired") {
    throw new TrialExpiredError(status.endsAt);
  }
  return status;
}

/**
 * Return the set of user IDs whose free trial is currently expired.
 * Used by worker ticks to skip dispatching/scraping for expired-trial tenants.
 */
export async function getTrialExpiredUserIdsSet(now: Date = new Date()): Promise<Set<string>> {
  if (!db.subscriptions?.findMany) return new Set();

  const expiredTrials = await db.subscriptions
    .findMany({
      where: {
        OR: [{ status: "trialing" }, { provider: "trial" }],
        current_period_end: { lte: now },
      },
      select: { user_id: true },
    })
    .catch(() => []);

  const candidateUserIds = Array.from(
    new Set(
      (expiredTrials || [])
        .map((s: any) => s.user_id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    )
  );

  if (candidateUserIds.length === 0) return new Set();

  const users = await db.users
    .findMany({
      where: { id: { in: candidateUserIds } },
      select: { id: true, role: true, plan: true, trial_exempt: true },
    })
    .catch(() => []);

  const expiredSet = new Set<string>();
  for (const u of users) {
    if (!u) continue;
    if (isAdminRole(u.role) || u.trial_exempt) continue;
    if (u.plan && u.plan !== "free") continue;
    expiredSet.add(u.id);
  }
  return expiredSet;
}

/**
 * Idempotent programmatic backfill for existing free-plan standard users without a subscription.
 * Gives each eligible user a 14-day trial starting from `now` without touching paid users or staff.
 */
export async function backfillFreeUserTrials(now: Date = new Date()): Promise<{
  createdCount: number;
  skippedCount: number;
}> {
  const freePlan = await ensureFreePlanRecord();
  if (!freePlan) {
    return { createdCount: 0, skippedCount: 0 };
  }

  const freeUsers = await db.users
    .findMany({
      where: { role: "user", plan: "free" },
      select: { id: true, role: true, plan: true, plan_id: true, trial_exempt: true },
    })
    .catch(() => []);

  const endsAt = new Date(now.getTime() + 14 * DAY_MS);
  let createdCount = 0;
  let skippedCount = 0;

  for (const u of freeUsers) {
    if (!u || isAdminRole(u.role) || u.trial_exempt || (u.plan && u.plan !== "free")) {
      skippedCount++;
      continue;
    }

    const existingSub = await db.subscriptions
      .findFirst({ where: { user_id: u.id } })
      .catch(() => null);
    if (existingSub) {
      skippedCount++;
      continue;
    }

    await db.subscriptions.create({
      data: {
        user_id: u.id,
        plan_id: freePlan.id,
        status: "trialing",
        current_period_start: now,
        current_period_end: endsAt,
        cancel_at_period_end: false,
        provider: "trial",
        provider_subscription_id: `trial_${u.id}`,
      },
    });

    if (!u.plan_id) {
      await db.users
        .update({
          where: { id: u.id },
          data: { plan_id: freePlan.id },
        })
        .catch(() => null);
    }

    createdCount++;
  }

  return { createdCount, skippedCount };
}

type TrialReminderMilestone = "4d" | "1d" | "expired";

function buildTrialReminderContent(
  milestone: TrialReminderMilestone,
  userName: string | null | undefined,
  endsAt: Date,
  billingUrl: string
) {
  const greetingName = userName?.trim() || "there";
  const formattedEnd = endsAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (milestone === "expired") {
    return {
      title: "Your free trial has ended",
      subject: "Your Lead Reach AI free trial has ended",
      body: `Your 14-day free trial ended on ${formattedEnd}. Upgrade to a paid plan to resume campaign sending, lead searches, and social auto-posting.`,
      text: `Hi ${greetingName},\n\nYour Lead Reach AI free trial ended on ${formattedEnd}.\n\nYour existing leads, campaigns, and reports are safe, and exports remain available. Upgrade to a paid plan to resume sending and automation:\n${billingUrl}\n`,
      html: `<p>Hi ${greetingName},</p><p>Your Lead Reach AI free trial ended on <strong>${formattedEnd}</strong>.</p><p>Your existing leads, campaigns, and reports are safe, and exports remain available. To resume sending, lead discovery, and social auto-posting, please upgrade to a paid plan:</p><p><a href="${billingUrl}">Upgrade Your Plan</a></p>`,
    };
  }

  if (milestone === "1d") {
    return {
      title: "1 day left in your free trial",
      subject: "Only 1 day left in your Lead Reach AI free trial",
      body: `Your free trial ends tomorrow (${formattedEnd}). Upgrade to a paid plan to keep your campaigns running without interruption.`,
      text: `Hi ${greetingName},\n\nYou have 1 day left in your Lead Reach AI free trial (ends ${formattedEnd}).\n\nUpgrade before the trial ends so your outreach campaigns and social schedules keep running without interruption:\n${billingUrl}\n`,
      html: `<p>Hi ${greetingName},</p><p>You have <strong>1 day left</strong> in your Lead Reach AI free trial (ends <strong>${formattedEnd}</strong>).</p><p>Upgrade before the trial ends so your outreach campaigns and social schedules keep running smoothly:</p><p><a href="${billingUrl}">Choose a Paid Plan</a></p>`,
    };
  }

  return {
    title: "4 days left in your free trial",
    subject: "4 days left in your Lead Reach AI free trial",
    body: `You have 4 days left in your free trial (ends ${formattedEnd}). Upgrade anytime to keep uninterrupted access to all features.`,
    text: `Hi ${greetingName},\n\nYou have 4 days left in your Lead Reach AI free trial (ends ${formattedEnd}).\n\nWhen the trial ends, sending, lead search, and social publishing will pause until you choose a paid plan:\n${billingUrl}\n`,
    html: `<p>Hi ${greetingName},</p><p>You have <strong>4 days left</strong> in your Lead Reach AI free trial (ends <strong>${formattedEnd}</strong>).</p><p>When the trial ends, outreach sending, lead discovery, and social publishing pause until you pick a paid plan:</p><p><a href="${billingUrl}">View Paid Plans</a></p>`,
  };
}

/**
 * Dispatch idempotent 4-day, 1-day, and expired trial reminders to verified account owners
 * and record in-app notification notices. Never throws on mailer or per-user errors.
 */
export async function processTrialReminders(now: Date = new Date()): Promise<{
  processed: number;
  emailsSent: number;
  noticesCreated: number;
}> {
  if (!db.subscriptions?.findMany) {
    return { processed: 0, emailsSent: 0, noticesCreated: 0 };
  }

  const trialSubs = await db.subscriptions
    .findMany({
      where: {
        OR: [{ status: "trialing" }, { provider: "trial" }],
      },
    })
    .catch(() => []);

  const appUrl = (await getAppUrl().catch(() => "http://localhost:3000")).replace(/\/$/, "");
  const billingUrl = `${appUrl}/app/settings/billing`;

  let processed = 0;
  let emailsSent = 0;
  let noticesCreated = 0;

  for (const sub of trialSubs) {
    try {
      const user = await db.users.findUnique({
        where: { id: sub.user_id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          plan: true,
          trial_exempt: true,
          email_verified_at: true,
        },
      });

      if (!user || isAdminRole(user.role) || user.trial_exempt) continue;
      if (user.plan && user.plan !== "free") continue;

      const endsAt = new Date(sub.current_period_end);
      const msLeft = endsAt.getTime() - now.getTime();
      let milestone: TrialReminderMilestone | null = null;

      if (msLeft <= 0) {
        milestone = "expired";
      } else {
        const daysLeft = Math.ceil(msLeft / DAY_MS);
        if (daysLeft === 1) {
          milestone = "1d";
        } else if (daysLeft <= 4) {
          milestone = "4d";
        }
      }

      if (!milestone) continue;
      processed++;

      const endDayStr = endsAt.toISOString().slice(0, 10);
      const noticeType = `trial_notice_${milestone}_${sub.id}_${endDayStr}`;
      const emailMarkerType = `trial_reminder_${milestone}_${sub.id}_${endDayStr}`;
      const content = buildTrialReminderContent(milestone, user.name, endsAt, billingUrl);

      // Record idempotent in-app notification if notifications model is available
      const notifApi = (db as any).notifications;
      if (notifApi?.findFirst && notifApi?.create) {
        const existingNotice = await notifApi
          .findFirst({ where: { user_id: user.id, type: noticeType } })
          .catch(() => null);
        if (!existingNotice) {
          const createdNotice = await notifApi
            .create({
              data: {
                user_id: user.id,
                type: noticeType,
                title: content.title,
                body: content.body,
                entity_type: "subscription",
                entity_id: sub.id,
              },
            })
            .catch(() => null);
          if (createdNotice) noticesCreated++;
        }
      }

      // Send email ONLY to verified email owners, idempotently
      if (!user.email_verified_at || !user.email) {
        continue;
      }

      const existingMarkers = await db.activity_logs
        .findMany({
          where: { user_id: user.id, type: emailMarkerType },
          take: 1,
        })
        .catch(() => []);

      if (existingMarkers.length > 0) {
        continue;
      }

      const mailRes = await sendSystemMail({
        to: user.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });

      if (!mailRes.ok) {
        logger.warn(
          { userId: user.id, milestone, err: mailRes.error },
          "Trial reminder email delivery failed; continuing maintenance"
        );
        continue;
      }

      await db.activity_logs
        .create({
          data: {
            user_id: user.id,
            type: emailMarkerType,
            message: `Trial ${milestone} reminder email sent to ${user.email}.`,
            meta: { subscriptionId: sub.id, milestone, endsAt: endsAt.toISOString() },
          },
        })
        .catch((err: any) => {
          logger.warn(
            { userId: user.id, milestone, err: err?.message },
            "Failed to persist trial reminder idempotency marker"
          );
        });

      emailsSent++;
    } catch (err: any) {
      logger.warn(
        { subId: sub?.id, err: err?.message },
        "Unexpected error while processing trial reminder; continuing"
      );
    }
  }

  return { processed, emailsSent, noticesCreated };
}
