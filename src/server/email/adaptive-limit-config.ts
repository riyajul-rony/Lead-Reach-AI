export type AdaptiveAccountPlanType = "free_gmail" | "workspace_trial" | "workspace_paid";
export type AdaptiveWorkspaceTier = "trial" | "paid";
export type AdaptiveAgeTier = "under_30d" | "30_to_89d" | "90_to_364d" | "365d_plus";

export interface AdaptiveLimitConfig {
  planCeilings: Record<AdaptiveAccountPlanType, number>;
  providerOfficialLimits: Record<AdaptiveAccountPlanType, number>;
  ageTierStartLimits: Record<AdaptiveAgeTier, number>;
  warmupBonus: number;
  warmupRequiredDays: number;
  weeklyIncrement: number;
  floorLimit: number;
  systemMaxDailyLimit: number;
  safetyOfficialLimitFraction: number;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getAdaptiveLimitConfig(
  overrides?: Partial<AdaptiveLimitConfig>
): AdaptiveLimitConfig {
  const defaults: AdaptiveLimitConfig = {
    planCeilings: {
      free_gmail: parsePositiveIntEnv("ADAPTIVE_CEILING_FREE_GMAIL", 50),
      workspace_trial: parsePositiveIntEnv("ADAPTIVE_CEILING_WORKSPACE_TRIAL", 50),
      workspace_paid: parsePositiveIntEnv("ADAPTIVE_CEILING_WORKSPACE_PAID", 100),
    },
    providerOfficialLimits: {
      free_gmail: parsePositiveIntEnv("PROVIDER_OFFICIAL_LIMIT_FREE_GMAIL", 500),
      workspace_trial: parsePositiveIntEnv("PROVIDER_OFFICIAL_LIMIT_WORKSPACE_TRIAL", 500),
      workspace_paid: parsePositiveIntEnv("PROVIDER_OFFICIAL_LIMIT_WORKSPACE_PAID", 2000),
    },
    ageTierStartLimits: {
      under_30d: parsePositiveIntEnv("ADAPTIVE_START_UNDER_30D", 10),
      "30_to_89d": parsePositiveIntEnv("ADAPTIVE_START_30_TO_89D", 20),
      "90_to_364d": parsePositiveIntEnv("ADAPTIVE_START_90_TO_364D", 30),
      "365d_plus": parsePositiveIntEnv("ADAPTIVE_START_365D_PLUS", 40),
    },
    warmupBonus: parsePositiveIntEnv("ADAPTIVE_WARMUP_BONUS", 10),
    warmupRequiredDays: parsePositiveIntEnv("ADAPTIVE_WARMUP_REQUIRED_DAYS", 14),
    weeklyIncrement: parsePositiveIntEnv("ADAPTIVE_WEEKLY_INCREMENT", 10),
    floorLimit: parsePositiveIntEnv("ADAPTIVE_LIMIT_FLOOR", 5),
    systemMaxDailyLimit: parsePositiveIntEnv("SYSTEM_MAX_DAILY_LIMIT", 150),
    safetyOfficialLimitFraction: 0.5,
  };

  if (!overrides) return defaults;

  return {
    ...defaults,
    ...overrides,
    planCeilings: {
      ...defaults.planCeilings,
      ...(overrides.planCeilings || {}),
    },
    providerOfficialLimits: {
      ...defaults.providerOfficialLimits,
      ...(overrides.providerOfficialLimits || {}),
    },
    ageTierStartLimits: {
      ...defaults.ageTierStartLimits,
      ...(overrides.ageTierStartLimits || {}),
    },
  };
}

export function normalizeAccountPlanType(
  rawType?: string | null,
  fromEmail?: string | null,
  workspaceTier?: string | null
): AdaptiveAccountPlanType {
  if (rawType === "free_gmail" || rawType === "workspace_trial" || rawType === "workspace_paid") {
    if (rawType !== "free_gmail" && workspaceTier === "paid") return "workspace_paid";
    if (rawType !== "free_gmail" && workspaceTier === "trial") return "workspace_trial";
    return rawType;
  }
  const domain = (fromEmail || "").split("@")[1]?.toLowerCase().trim() || "";
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return "free_gmail";
  }
  return workspaceTier === "paid" ? "workspace_paid" : "workspace_trial";
}
