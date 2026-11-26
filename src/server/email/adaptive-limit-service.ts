import { db } from "@/server/db";
import { logger } from "@/server/logger";
import {
  getAdaptiveLimitConfig,
  normalizeAccountPlanType,
  type AdaptiveAccountPlanType,
  type AdaptiveAgeTier,
  type AdaptiveLimitConfig,
} from "@/server/email/adaptive-limit-config";

export interface AgeTierInfo {
  tier: AdaptiveAgeTier;
  label: string;
}

export function getAccountAgeTier(detectedAgeDays?: number | null): AgeTierInfo {
  if (detectedAgeDays == null || !Number.isFinite(detectedAgeDays) || detectedAgeDays < 30) {
    return { tier: "under_30d", label: "< 30 days" };
  }
  if (detectedAgeDays <= 89) {
    return { tier: "30_to_89d", label: "30–89 days" };
  }
  if (detectedAgeDays <= 364) {
    return { tier: "90_to_364d", label: "90–364 days" };
  }
  return { tier: "365d_plus", label: "365+ days" };
}

export async function getHealthyWarmupDaysCount(accountId: string): Promise<number> {
  if (!db.warmup_logs?.findMany) return 0;
  try {
    const logs = await db.warmup_logs.findMany({
      where: {
        from_account_id: accountId,
        status: { in: ["sent", "replied"] },
      },
      select: { sent_at: true },
    });
    const days = new Set<string>();
    for (const log of logs || []) {
      if (log?.sent_at) {
        days.add(new Date(log.sent_at).toISOString().slice(0, 10));
      }
    }
    return days.size;
  } catch {
    return 0;
  }
}

export function calculateStartLimit(params: {
  planType: AdaptiveAccountPlanType;
  detectedAgeDays?: number | null;
  hasWarmupBonus: boolean;
  config?: AdaptiveLimitConfig;
}): number {
  const cfg = params.config || getAdaptiveLimitConfig();
  const ceiling = cfg.planCeilings[params.planType];
  const ageTier = getAccountAgeTier(params.detectedAgeDays).tier;
  const baseStart = cfg.ageTierStartLimits[ageTier];
  const withWarmup = baseStart + (params.hasWarmupBonus ? cfg.warmupBonus : 0);
  return Math.max(cfg.floorLimit, Math.min(ceiling, withWarmup));
}

export function computeEffectiveAdaptiveLimit(
  account: {
    from_email?: string | null;
    account_type?: string | null;
    workspace_tier?: string | null;
    detected_age_days?: number | null;
    ramp_started_at?: Date | string | null;
    start_limit_snapshot?: number | null;
    healthy_weeks_completed?: number | null;
    user_daily_limit?: number | null;
    admin_daily_limit_override?: number | null;
    // Legacy compatibility fields
    warmup_enabled?: boolean | null;
    warmup_day?: number | null;
    warmup_start_limit?: number | null;
    warmup_daily_increment?: number | null;
    warmup_max_limit?: number | null;
    daily_limit?: number | null;
  },
  opts?: {
    hasWarmupBonus?: boolean;
    config?: AdaptiveLimitConfig;
  }
): {
  planType: AdaptiveAccountPlanType;
  planCeiling: number;
  startLimit: number;
  rampLimit: number;
  effectiveLimit: number;
} {
  const cfg = opts?.config || getAdaptiveLimitConfig();
  const planType = normalizeAccountPlanType(
    account.account_type,
    account.from_email,
    account.workspace_tier
  );
  const planCeiling = cfg.planCeilings[planType];

  // Legacy pre-Phase-6 compatibility ONLY when no Phase 6 adaptive fields are used
  // and a legacy fixture/account uses warmup_start_limit without Phase 6 detection.
  const hasPhase6Signals =
    account.account_type != null ||
    account.detected_age_days != null ||
    account.ramp_started_at != null ||
    account.start_limit_snapshot != null ||
    account.user_daily_limit != null ||
    account.admin_daily_limit_override != null;

  if (
    !hasPhase6Signals &&
    account.warmup_enabled &&
    account.warmup_start_limit != null &&
    account.warmup_start_limit > 0
  ) {
    const day = Math.max(1, account.warmup_day || 1);
    const start = account.warmup_start_limit;
    const inc = account.warmup_daily_increment || 5;
    const max = account.warmup_max_limit || 50;
    const legacyCap = Math.min(account.daily_limit || max, start + (day - 1) * inc, max);
    return {
      planType,
      planCeiling,
      startLimit: start,
      rampLimit: legacyCap,
      effectiveLimit: legacyCap,
    };
  }

  const computedStart = calculateStartLimit({
    planType,
    detectedAgeDays: account.detected_age_days,
    hasWarmupBonus: Boolean(opts?.hasWarmupBonus),
    config: cfg,
  });

  // Once ramp has started, start_limit_snapshot preserves the original start tier
  const startLimit =
    account.ramp_started_at && account.start_limit_snapshot != null
      ? Math.max(cfg.floorLimit, Math.min(planCeiling, account.start_limit_snapshot))
      : computedStart;

  const healthyWeeks = Math.max(0, account.healthy_weeks_completed || 0);
  const rampLimit = startLimit + cfg.weeklyIncrement * healthyWeeks;

  let effectiveLimit: number;
  if (
    account.admin_daily_limit_override != null &&
    Number.isFinite(account.admin_daily_limit_override)
  ) {
    // Admin override explicitly supersedes plan ceiling and weekly ramp up to SYSTEM_MAX_DAILY_LIMIT (default 150)
    const adminBound = Math.max(
      cfg.floorLimit,
      Math.min(cfg.systemMaxDailyLimit, Math.floor(account.admin_daily_limit_override))
    );
    effectiveLimit =
      account.user_daily_limit != null && Number.isFinite(account.user_daily_limit)
        ? Math.max(cfg.floorLimit, Math.min(adminBound, Math.floor(account.user_daily_limit)))
        : adminBound;
  } else {
    const bounds = [planCeiling, rampLimit];
    if (account.user_daily_limit != null && Number.isFinite(account.user_daily_limit)) {
      bounds.push(Math.floor(account.user_daily_limit));
    }
    effectiveLimit = Math.max(cfg.floorLimit, Math.min(...bounds));
  }

  return {
    planType,
    planCeiling,
    startLimit,
    rampLimit,
    effectiveLimit,
  };
}

/**
 * Computes and returns the full UI / API adaptive limit status summary for an account.
 */
export async function getAccountAdaptiveLimitSummary(
  account: any,
  counts?: {
    campaignSentToday?: number;
    warmupSentToday?: number;
    hasWarmupBonus?: boolean;
  },
  now: Date = new Date()
) {
  const cfg = getAdaptiveLimitConfig();
  const hasWarmupBonus =
    counts?.hasWarmupBonus !== undefined
      ? counts.hasWarmupBonus
      : (await getHealthyWarmupDaysCount(account.id)) >= cfg.warmupRequiredDays;

  const calc = computeEffectiveAdaptiveLimit(account, {
    hasWarmupBonus,
    config: cfg,
  });
  const ageInfo = getAccountAgeTier(account.detected_age_days);
  const usedToday = counts?.campaignSentToday ?? 0;
  const warmupToday = counts?.warmupSentToday ?? 0;
  const officialLimit = cfg.providerOfficialLimits[calc.planType];
  const maxCombined50 = Math.floor(officialLimit * cfg.safetyOfficialLimitFraction);
  const remaining50PctCap = Math.max(0, maxCombined50 - warmupToday);
  const todayEffectiveCap = Math.min(calc.effectiveLimit, remaining50PctCap);

  const isRateLimitedNow = Boolean(
    account.rate_limited_until && new Date(account.rate_limited_until) > now
  );
  const remainingToday = isRateLimitedNow ? 0 : Math.max(0, todayEffectiveCap - usedToday);

  let nextIncreaseDate: string | null = null;
  if (account.ramp_started_at && calc.effectiveLimit < calc.planCeiling) {
    const baseTime = account.last_evaluated_at
      ? new Date(account.last_evaluated_at).getTime()
      : new Date(account.ramp_started_at).getTime();
    nextIncreaseDate = new Date(baseTime + 7 * 86400000).toISOString();
  }

  let healthStatus: "healthy" | "holding" | "reduced" | "paused" = "healthy";
  if (
    account.status === "paused" ||
    account.status === "paused_deliverability" ||
    account.status === "needs_attention" ||
    account.health_status === "paused"
  ) {
    healthStatus = "paused";
  } else if (
    account.health_status === "reduced" ||
    account.health_status === "holding" ||
    account.health_status === "healthy"
  ) {
    healthStatus = account.health_status;
  }

  return {
    accountType: calc.planType,
    workspaceTier:
      calc.planType === "free_gmail"
        ? null
        : calc.planType === "workspace_paid"
          ? "paid"
          : "trial",
    ageTier: ageInfo.tier,
    ageTierLabel: ageInfo.label,
    ageSource: (account.age_source || "fallback") as "imap" | "fallback",
    ageVerificationFailed: account.age_source !== "imap",
    detectedAgeDays: account.detected_age_days ?? null,
    messageCount: account.message_count ?? null,
    detectedAt: account.detected_at ? new Date(account.detected_at).toISOString() : null,
    hasWarmupBonus,
    startLimit: calc.startLimit,
    planCeiling: calc.planCeiling,
    officialLimit,
    effectiveDailyLimit: todayEffectiveCap,
    baseAdaptiveLimit: calc.effectiveLimit,
    usedToday,
    warmupToday,
    remainingToday,
    healthyWeeksCompleted: account.healthy_weeks_completed || 0,
    rampStartedAt: account.ramp_started_at ? new Date(account.ramp_started_at).toISOString() : null,
    nextIncreaseDate,
    healthStatus,
    userDailyLimit: account.user_daily_limit ?? null,
    adminDailyLimitOverride: account.admin_daily_limit_override ?? null,
    rateLimitedUntil: isRateLimitedNow
      ? new Date(account.rate_limited_until).toISOString()
      : null,
  };
}

/**
 * Evaluates one completed 7-day window for a single ramped email account.
 * Records oldLimit -> newLimit transitions into account_limit_history.
 */
export async function evaluateAccountSevenDayWindow(
  account: any,
  now: Date = new Date()
): Promise<{
  evaluated: boolean;
  outcome?: "healthy" | "hold" | "reduced" | "paused";
  oldLimit?: number;
  newLimit?: number;
}> {
  if (!account.ramp_started_at) {
    return { evaluated: false };
  }

  const rampStartMs = new Date(account.ramp_started_at).getTime();
  const anchorMs = account.last_evaluated_at
    ? new Date(account.last_evaluated_at).getTime()
    : rampStartMs;
  const sevenDaysMs = 7 * 86400 * 1000;

  if (now.getTime() - anchorMs < sevenDaysMs) {
    return { evaluated: false };
  }

  const windowStart = new Date(anchorMs);
  const windowEnd = new Date(Math.min(now.getTime(), anchorMs + sevenDaysMs));

  const cfg = getAdaptiveLimitConfig();
  const warmupDays = await getHealthyWarmupDaysCount(account.id);
  const hasWarmupBonus = warmupDays >= cfg.warmupRequiredDays;

  const beforeCalc = computeEffectiveAdaptiveLimit(account, {
    hasWarmupBonus,
    config: cfg,
  });
  const oldLimit = account.current_daily_limit ?? beforeCalc.effectiveLimit;

  // Query campaign sends & hard bounces inside [windowStart, windowEnd]
  const sentMessages = await db.email_messages.findMany({
    where: {
      email_account_id: account.id,
      direction: "out",
      kind: { in: ["initial", "followup"] },
      status: "sent",
      sent_at: { gte: windowStart, lte: windowEnd },
    },
    select: { sent_at: true },
  });
  const windowSends = sentMessages.length;

  const bouncedRecipients = await db.campaign_recipients.findMany({
    where: {
      assigned_account_id: account.id,
      status: "bounced",
    },
    select: { last_sent_at: true, sent_at: true, created_at: true },
  });
  const windowBounces = (bouncedRecipients || []).filter((r: any) => {
    const ts = new Date(r.last_sent_at || r.sent_at || r.created_at || 0).getTime();
    return ts >= windowStart.getTime() && ts <= windowEnd.getTime();
  }).length;

  const bounceRate = windowSends > 0 ? windowBounces / windowSends : 0;

  // Check error flags in this window
  const rateLimitHitInWindow = Boolean(
    account.rate_limit_hit_at &&
      new Date(account.rate_limit_hit_at).getTime() >= windowStart.getTime() &&
      new Date(account.rate_limit_hit_at).getTime() <= windowEnd.getTime()
  );

  const hasAuthFailure =
    account.status === "needs_attention" ||
    Boolean(
      account.last_error &&
        /EAUTH|BadCredentials|535|reconnection required|invalid_grant/i.test(account.last_error)
    );
  const hasDeliverabilityPause =
    account.status === "paused_deliverability" || account.health_status === "paused";

  let nextHealthyWeeks = Math.max(0, account.healthy_weeks_completed || 0);
  let nextHealthStatus: "healthy" | "holding" | "reduced" | "paused" = "holding";
  let outcome: "healthy" | "hold" | "reduced" | "paused" = "hold";
  let reason = "Window held (insufficient volume)";

  if (hasDeliverabilityPause) {
    nextHealthStatus = "paused";
    outcome = "paused";
    reason = "Paused due to deliverability signal during 7-day window";
  } else if (bounceRate > 0.05 || rateLimitHitInWindow) {
    nextHealthyWeeks = Math.max(0, nextHealthyWeeks - 1);
    nextHealthStatus = "reduced";
    outcome = "reduced";
    reason = rateLimitHitInWindow
      ? "Gmail daily rate limit reached during 7-day window (-1 healthy week)"
      : `High hard-bounce rate ${(bounceRate * 100).toFixed(1)}% (>5%) in 7-day window (-1 healthy week)`;
  } else if (bounceRate >= 0.02 || hasAuthFailure) {
    nextHealthStatus = "holding";
    outcome = "hold";
    reason = hasAuthFailure
      ? "SMTP authentication issue during 7-day window (holding limit)"
      : `Elevated hard-bounce rate ${(bounceRate * 100).toFixed(1)}% (>=2%) in 7-day window (holding limit)`;
  } else {
    // Bounce rate < 2%, no Gmail rate limit errors, no auth failures, no pause
    let meetsVolumeRequirement = windowSends >= 30;
    if (!meetsVolumeRequirement && windowSends > 0) {
      const sendsByUtcDay = new Map<string, number>();
      for (const m of sentMessages) {
        const dayKey = new Date(m.sent_at).toISOString().slice(0, 10);
        sendsByUtcDay.set(dayKey, (sendsByUtcDay.get(dayKey) || 0) + 1);
      }
      const halfLimitThreshold = beforeCalc.effectiveLimit * 0.5;
      let activeDays = 0;
      for (const count of sendsByUtcDay.values()) {
        if (count >= halfLimitThreshold) activeDays++;
      }
      meetsVolumeRequirement = activeDays >= 4;
    }

    if (meetsVolumeRequirement) {
      nextHealthyWeeks += 1;
      nextHealthStatus = "healthy";
      outcome = "healthy";
      reason = `Healthy 7-day window (${windowSends} sends, ${(bounceRate * 100).toFixed(1)}% bounce rate): +1 healthy week`;
    } else {
      nextHealthStatus = "holding";
      outcome = "hold";
      reason = `Low send volume (${windowSends} sends) in 7-day window: holding limit`;
    }
  }

  const afterCalc = computeEffectiveAdaptiveLimit(
    {
      ...account,
      healthy_weeks_completed: nextHealthyWeeks,
    },
    { hasWarmupBonus, config: cfg }
  );

  await db.email_accounts.update({
    where: { id: account.id },
    data: {
      healthy_weeks_completed: nextHealthyWeeks,
      current_daily_limit: afterCalc.effectiveLimit,
      last_evaluated_at: windowEnd,
      health_status: nextHealthStatus,
    },
  });

  if (oldLimit !== afterCalc.effectiveLimit && db.account_limit_history?.create) {
    await db.account_limit_history.create({
      data: {
        account_id: account.id,
        user_id: account.user_id,
        date: windowEnd,
        old_limit: oldLimit,
        new_limit: afterCalc.effectiveLimit,
        reason,
      },
    });
  }

  return {
    evaluated: true,
    outcome,
    oldLimit,
    newLimit: afterCalc.effectiveLimit,
  };
}

/**
 * Daily scheduler job (gated under SCHEDULERS_ENABLED): evaluates 7-day health windows
 * for all accounts whose outreach ramp has started.
 */
export async function evaluateDailyAccountHealth(now: Date = new Date()): Promise<{
  checked: number;
  evaluated: number;
}> {
  const accounts = await db.email_accounts.findMany({
    where: { status: { in: ["active", "paused_deliverability"] } },
  });

  let checked = 0;
  let evaluated = 0;
  for (const acc of accounts) {
    if (!acc.ramp_started_at) continue;
    checked++;
    try {
      const res = await evaluateAccountSevenDayWindow(acc, now);
      if (res.evaluated) evaluated++;
    } catch (err) {
      logger.error({ err, accountId: acc.id }, "Daily account health evaluation failed");
    }
  }

  return { checked, evaluated };
}

/**
 * Admin-only override up to SYSTEM_MAX_DAILY_LIMIT (default 150).
 * Logs both account_limit_history and admin_actions audit trail.
 */
export async function setAdminAccountDailyLimitOverride(params: {
  adminId: string;
  accountId: string;
  overrideLimit: number | null;
  reason?: string;
}) {
  const cfg = getAdaptiveLimitConfig();
  if (params.overrideLimit !== null) {
    if (!Number.isFinite(params.overrideLimit)) {
      throw new Error("Override limit must be a valid number");
    }
    const cleanVal = Math.floor(params.overrideLimit);
    if (cleanVal < cfg.floorLimit || cleanVal > cfg.systemMaxDailyLimit) {
      throw new Error(
        `Admin override limit must be between ${cfg.floorLimit} and ${cfg.systemMaxDailyLimit}`
      );
    }
  }

  const account = await db.email_accounts.findUnique({ where: { id: params.accountId } });
  if (!account) {
    throw new Error("Email account not found");
  }

  const warmupDays = await getHealthyWarmupDaysCount(account.id);
  const hasWarmupBonus = warmupDays >= cfg.warmupRequiredDays;
  const beforeCalc = computeEffectiveAdaptiveLimit(account, { hasWarmupBonus, config: cfg });
  const oldLimit = account.current_daily_limit ?? beforeCalc.effectiveLimit;

  const nextOverride =
    params.overrideLimit === null ? null : Math.floor(params.overrideLimit);
  const afterCalc = computeEffectiveAdaptiveLimit(
    {
      ...account,
      admin_daily_limit_override: nextOverride,
    },
    { hasWarmupBonus, config: cfg }
  );

  const updated = await db.email_accounts.update({
    where: { id: account.id },
    data: {
      admin_daily_limit_override: nextOverride,
      current_daily_limit: afterCalc.effectiveLimit,
    },
  });

  const cleanReason =
    params.reason?.trim() ||
    (nextOverride === null
      ? "Admin cleared daily limit override"
      : `Admin set daily limit override to ${nextOverride}`);

  if (oldLimit !== afterCalc.effectiveLimit && db.account_limit_history?.create) {
    await db.account_limit_history.create({
      data: {
        account_id: account.id,
        user_id: account.user_id,
        date: new Date(),
        old_limit: oldLimit,
        new_limit: afterCalc.effectiveLimit,
        reason: cleanReason,
      },
    });
  }

  if (db.admin_actions?.create) {
    await db.admin_actions.create({
      data: {
        admin_id: params.adminId,
        action: "account_daily_limit_override",
        reason: cleanReason,
        target_user_id: account.user_id,
        account_id: account.id,
        metadata: {
          oldLimit,
          newEffectiveLimit: afterCalc.effectiveLimit,
          adminOverride: nextOverride,
          systemMaxDailyLimit: cfg.systemMaxDailyLimit,
        },
      },
    });
  }

  return {
    account: updated,
    oldLimit,
    newLimit: afterCalc.effectiveLimit,
    adminOverride: nextOverride,
  };
}
