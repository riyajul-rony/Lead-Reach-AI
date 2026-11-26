export interface SendJitterBounds {
  minSeconds: number;
  maxSeconds: number;
}

const DEFAULT_JITTER_MIN_SECONDS = 120;
const DEFAULT_JITTER_MAX_SECONDS = 300;
const MIN_ALLOWED_JITTER_SECONDS = 30;

function parsePositiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Global default send jitter bounds (2 to 5 minutes = 120–300s by default),
 * configurable via SEND_JITTER_MIN_SECONDS and SEND_JITTER_MAX_SECONDS.
 */
export function getDefaultSendJitterBounds(): SendJitterBounds {
  const envMin = parsePositiveIntEnv("SEND_JITTER_MIN_SECONDS");
  const envMax = parsePositiveIntEnv("SEND_JITTER_MAX_SECONDS");

  const minSeconds = Math.max(
    MIN_ALLOWED_JITTER_SECONDS,
    envMin ?? DEFAULT_JITTER_MIN_SECONDS
  );
  const maxSeconds = Math.max(
    minSeconds,
    envMax ?? DEFAULT_JITTER_MAX_SECONDS
  );

  return { minSeconds, maxSeconds };
}

/**
 * Resolves effective jitter bounds [minSeconds, maxSeconds] for a sending account,
 * prioritizing explicit env overrides when configured, then account overrides,
 * then campaign defaults, and falling back to 120–300s.
 */
export function resolveAccountJitterBounds(
  account?: {
    min_gap_seconds?: number | null;
    max_gap_seconds?: number | null;
    gap_seconds?: number | null;
  } | null,
  campaign?: {
    jitter_min_sec?: number | null;
    jitter_max_sec?: number | null;
  } | null
): SendJitterBounds {
  const defaults = getDefaultSendJitterBounds();
  const hasEnvMin = parsePositiveIntEnv("SEND_JITTER_MIN_SECONDS") !== null;
  const hasEnvMax = parsePositiveIntEnv("SEND_JITTER_MAX_SECONDS") !== null;

  const accountMin =
    account?.min_gap_seconds && account.min_gap_seconds > 0
      ? account.min_gap_seconds
      : account?.gap_seconds && account.gap_seconds > 0
        ? account.gap_seconds
        : null;
  const accountMax =
    account?.max_gap_seconds && account.max_gap_seconds > 0
      ? account.max_gap_seconds
      : null;

  const minSeconds = Math.max(
    MIN_ALLOWED_JITTER_SECONDS,
    Math.floor(
      hasEnvMin
        ? defaults.minSeconds
        : (accountMin ?? campaign?.jitter_min_sec ?? defaults.minSeconds)
    )
  );

  const maxSeconds = Math.max(
    minSeconds,
    Math.floor(
      hasEnvMax
        ? defaults.maxSeconds
        : (accountMax ?? campaign?.jitter_max_sec ?? Math.max(minSeconds, defaults.maxSeconds))
    )
  );

  return { minSeconds, maxSeconds };
}

/**
 * Picks a randomized integer delay in seconds within [minSeconds, maxSeconds].
 */
export function computeSendJitterSeconds(
  minSec?: number,
  maxSec?: number,
  randomFn: () => number = Math.random
): number {
  const defaults = getDefaultSendJitterBounds();
  const min = Math.max(0, Math.floor(minSec ?? defaults.minSeconds));
  const max = Math.max(min, Math.floor(maxSec ?? Math.max(min, defaults.maxSeconds)));
  const r = Math.min(0.9999999999, Math.max(0, randomFn()));
  return Math.floor(r * (max - min + 1)) + min;
}
