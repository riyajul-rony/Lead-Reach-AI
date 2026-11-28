import { db } from "@/server/db";
import { getConfig } from "@/server/config";
import { isAdminRole } from "@/server/auth/permissions";
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
