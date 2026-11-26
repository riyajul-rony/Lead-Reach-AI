import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { getRedisConnection } from "@/server/queues";
import { getAdaptiveLimitConfig } from "@/server/email/adaptive-limit-config";
import {
  computeEffectiveAdaptiveLimit,
  getHealthyWarmupDaysCount,
} from "@/server/email/adaptive-limit-service";

export function getUtcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getUtcDayStart(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
}

export function getUtcNextDayStart(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
}

/**
 * Detects Gmail / Google Workspace daily or rate-limit SMTP/API errors (e.g. 550 5.4.5, 454 4.7.0).
 */
export function isGmailDailyLimitError(errorMsg = ""): boolean {
  const msg = String(errorMsg).toLowerCase();
  return (
    /550[- ]5\.4\.5/.test(msg) ||
    /454[- ]4\.7\.0/.test(msg) ||
    msg.includes("daily user sending limit exceeded") ||
    msg.includes("user-rate limit exceeded") ||
    msg.includes("daily sending quota exceeded") ||
    msg.includes("too many messages started")
  );
}

export async function markAccountRateLimitedForToday(
  accountId: string,
  errorMsg: string,
  now: Date = new Date()
) {
  const nextDay = getUtcNextDayStart(now);
  await db.email_accounts.update({
    where: { id: accountId },
    data: {
      rate_limited_until: nextDay,
      rate_limit_hit_at: now,
      health_status: "reduced",
      last_error: `Provider rate limit reached (${errorMsg}). Paused until ${nextDay.toISOString()}.`,
    },
  });
  return nextDay;
}

// Per-account mutex & in-flight UTC day reservations for single-node concurrency & test fallback
const accountLockTails = new Map<string, Promise<void>>();
const inFlightDayReservations = new Map<string, number>();

async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const previous = accountLockTails.get(accountId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((res) => {
    release = res;
  });
  const nextTail = previous.then(() => current, () => current);
  accountLockTails.set(accountId, nextTail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (accountLockTails.get(accountId) === nextTail) {
      accountLockTails.delete(accountId);
    }
  }
}

export interface DailyCapacitySnapshot {
  utcDayKey: string;
  campaignSentToday: number;
  warmupSentToday: number;
  adaptiveCap: number;
  officialLimit: number;
  safetyMaxCombined: number;
  remaining50PctCampaignCap: number;
  effectiveCampaignDailyCap: number;
  reservedInFlight: number;
  remainingCampaignToday: number;
  isRateLimitedToday: boolean;
  rateLimitedUntil: string | null;
}

export async function getAccountDailyCapacitySnapshot(
  account: any,
  now: Date = new Date()
): Promise<DailyCapacitySnapshot> {
  const cfg = getAdaptiveLimitConfig();
  const utcDayKey = getUtcDayKey(now);
  const utcStart = getUtcDayStart(now);

  const hasWarmupBonus = (await getHealthyWarmupDaysCount(account.id)) >= cfg.warmupRequiredDays;
  const calc = computeEffectiveAdaptiveLimit(account, {
    hasWarmupBonus,
    config: cfg,
  });

  const [campaignSentToday, warmupSentToday] = await Promise.all([
    db.email_messages?.count
      ? db.email_messages.count({
          where: {
            email_account_id: account.id,
            direction: "out",
            status: "sent",
            sent_at: { gte: utcStart },
          },
        })
      : Promise.resolve(0),
    db.warmup_logs?.findMany
      ? db.warmup_logs
          .findMany({
            where: {
              from_account_id: account.id,
              status: { in: ["sent", "replied"] },
              sent_at: { gte: utcStart },
            },
            select: { id: true },
          })
          .then((rows: any[]) => rows.length)
      : Promise.resolve(0),
  ]);

  const officialLimit = cfg.providerOfficialLimits[calc.planType];
  const safetyMaxCombined = Math.floor(officialLimit * cfg.safetyOfficialLimitFraction);
  const remaining50PctCampaignCap = Math.max(0, safetyMaxCombined - warmupSentToday);

  // Safety invariant: campaign + warmup sends <= 50% of official limit; reduce campaign cap first.
  const effectiveCampaignDailyCap = Math.min(calc.effectiveLimit, remaining50PctCampaignCap);

  const reservationKey = `${account.id}:${utcDayKey}`;
  const reservedInFlight = inFlightDayReservations.get(reservationKey) || 0;

  const isRateLimitedToday = Boolean(
    account.rate_limited_until && new Date(account.rate_limited_until) > now
  );
  const remainingCampaignToday = isRateLimitedToday
    ? 0
    : Math.max(0, effectiveCampaignDailyCap - (campaignSentToday + reservedInFlight));

  return {
    utcDayKey,
    campaignSentToday,
    warmupSentToday,
    adaptiveCap: calc.effectiveLimit,
    officialLimit,
    safetyMaxCombined,
    remaining50PctCampaignCap,
    effectiveCampaignDailyCap,
    reservedInFlight,
    remainingCampaignToday,
    isRateLimitedToday,
    rateLimitedUntil: isRateLimitedToday
      ? new Date(account.rate_limited_until).toISOString()
      : null,
  };
}

export interface DailyCapacityReservation {
  accountId: string;
  utcDayKey: string;
  usedRedis: boolean;
  redisKey?: string;
}

const REDIS_ATOMIC_RESERVE_LUA = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local seed = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call("EXISTS", key) == 0 then
  redis.call("SET", key, seed, "EX", ttl)
end
local cur = tonumber(redis.call("GET", key) or "0")
if cur >= cap then
  return {0, cur}
end
local nextVal = redis.call("INCR", key)
if redis.call("TTL", key) < 0 then
  redis.call("EXPIRE", key, ttl)
end
return {1, nextVal}
`;

const REDIS_ATOMIC_RELEASE_LUA = `
local key = KEYS[1]
if redis.call("EXISTS", key) == 1 then
  local cur = tonumber(redis.call("GET", key) or "0")
  if cur > 0 then
    return redis.call("DECR", key)
  end
end
return 0
`;

/**
 * Atomically reserves 1 campaign send slot for this account for the current UTC day.
 * Concurrent workers & retries can never exceed min(adaptiveCap, remaining50PctCap).
 * Call commitAccountDailyCapacity() after DB persistence, or releaseAccountDailyCapacity()
 * if transport fails before mail server acceptance.
 */
export async function reserveAccountDailyCapacity(
  account: any,
  now: Date = new Date()
): Promise<
  | { allowed: true; reservation: DailyCapacityReservation; snapshot: DailyCapacitySnapshot }
  | { allowed: false; reason: string; snapshot: DailyCapacitySnapshot }
> {
  return withAccountLock(account.id, async () => {
    const snapshot = await getAccountDailyCapacitySnapshot(account, now);

    if (snapshot.isRateLimitedToday) {
      return {
        allowed: false,
        reason: `Gmail/provider daily limit reached (retry after ${snapshot.rateLimitedUntil})`,
        snapshot,
      };
    }

    if (snapshot.effectiveCampaignDailyCap <= 0) {
      return {
        allowed: false,
        reason: "Account daily warmup limit reached (50% provider safety invariant)",
        snapshot,
      };
    }

    const totalConsumed = snapshot.campaignSentToday + snapshot.reservedInFlight;
    if (totalConsumed >= snapshot.effectiveCampaignDailyCap) {
      return {
        allowed: false,
        reason: "Daily warmup limit reached for account",
        snapshot,
      };
    }

    const reservationKey = `${account.id}:${snapshot.utcDayKey}`;
    const redisKey = `leadreach:quota:campaign:${reservationKey}`;
    let usedRedis = false;

    try {
      const redis = getRedisConnection();
      if (redis.status === "ready") {
        const secondsUntilTomorrow = Math.max(
          60,
          Math.ceil((getUtcNextDayStart(now).getTime() - now.getTime()) / 1000) + 3600
        );
        const evalRes = (await redis.eval(
          REDIS_ATOMIC_RESERVE_LUA,
          1,
          redisKey,
          String(snapshot.effectiveCampaignDailyCap),
          String(snapshot.campaignSentToday),
          String(secondsUntilTomorrow)
        )) as [number, number];

        if (!evalRes || Number(evalRes[0]) !== 1) {
          return {
            allowed: false,
            reason: "Daily warmup limit reached for account",
            snapshot,
          };
        }
        usedRedis = true;
      }
    } catch (redisErr: any) {
      logger.debug({ err: redisErr?.message }, "Redis unavailable for atomic quota; using lock fallback");
    }

    inFlightDayReservations.set(reservationKey, (inFlightDayReservations.get(reservationKey) || 0) + 1);

    return {
      allowed: true,
      reservation: {
        accountId: account.id,
        utcDayKey: snapshot.utcDayKey,
        usedRedis,
        redisKey: usedRedis ? redisKey : undefined,
      },
      snapshot,
    };
  });
}

/**
 * Releases an in-flight lock once the sent email has been persisted in `email_messages`,
 * keeping DB count & Redis count reconciled without double-counting.
 */
export function commitAccountDailyCapacity(reservation: DailyCapacityReservation | null | undefined) {
  if (!reservation) return;
  const reservationKey = `${reservation.accountId}:${reservation.utcDayKey}`;
  const current = inFlightDayReservations.get(reservationKey) || 0;
  if (current <= 1) {
    inFlightDayReservations.delete(reservationKey);
  } else {
    inFlightDayReservations.set(reservationKey, current - 1);
  }
}

/**
 * Releases capacity on pre-acceptance failure so failed sends never permanently consume quota.
 */
export async function releaseAccountDailyCapacity(
  reservation: DailyCapacityReservation | null | undefined
) {
  if (!reservation) return;
  commitAccountDailyCapacity(reservation);

  if (reservation.usedRedis && reservation.redisKey) {
    try {
      const redis = getRedisConnection();
      if (redis.status === "ready") {
        await redis.eval(REDIS_ATOMIC_RELEASE_LUA, 1, reservation.redisKey);
      }
    } catch {}
  }
}

/**
 * Marks `ramp_started_at` and freezes `start_limit_snapshot` on the account's very first campaign send.
 */
export async function ensureAccountRampStarted(account: any, now: Date = new Date()): Promise<void> {
  if (account.ramp_started_at) return;
  try {
    const cfg = getAdaptiveLimitConfig();
    const hasWarmupBonus = (await getHealthyWarmupDaysCount(account.id)) >= cfg.warmupRequiredDays;
    const calc = computeEffectiveAdaptiveLimit(account, {
      hasWarmupBonus,
      config: cfg,
    });
    await db.email_accounts.update({
      where: { id: account.id },
      data: {
        ramp_started_at: now,
        start_limit_snapshot: calc.startLimit,
        current_daily_limit: calc.effectiveLimit,
      },
    });
    account.ramp_started_at = now;
    account.start_limit_snapshot = calc.startLimit;
  } catch (err) {
    logger.warn({ err, accountId: account.id }, "Failed to mark account ramp_started_at");
  }
}
