export interface WarmupUiAccountLike {
  id: string;
  status: string;
  warmup_enabled?: boolean | null;
  warmup_day?: number | null;
  warmup_start_limit?: number | null;
  warmup_daily_increment?: number | null;
  warmup_max_limit?: number | null;
}

/**
 * Computes today's warm-up volume target for a mailbox based on its ramp config.
 */
export function getWarmupDailyTarget(acc: WarmupUiAccountLike): number {
  const day = Math.max(1, Number(acc.warmup_day) || 1);
  const start = Math.max(1, Number(acc.warmup_start_limit) || 10);
  const inc = Math.max(1, Number(acc.warmup_daily_increment) || 5);
  const max = Math.max(start, Number(acc.warmup_max_limit) || 50);
  return Math.min(max, start + (day - 1) * inc);
}

/**
 * Returns a concise pill label for an inbox's warm-up state.
 */
export function getWarmupStatusPillLabel(acc: WarmupUiAccountLike): string {
  if (!acc.warmup_enabled) return "Warm-up Off";
  const target = getWarmupDailyTarget(acc);
  return `Warming ${target}/day`;
}

/**
 * Builds a deterministic React effect key so warm-up summaries refresh
 * whenever any account's status or warmup_enabled changes.
 */
export function getWarmupStateKey(accounts: WarmupUiAccountLike[]): string {
  return accounts
    .map((a) => `${a.id}:${a.status}:${Boolean(a.warmup_enabled)}`)
    .join("|");
}

/**
 * Returns active accounts that currently have warm-up disabled.
 */
export function getActiveAccountsWithWarmupOff<T extends WarmupUiAccountLike>(accounts: T[]): T[] {
  return accounts.filter((a) => a.status === "active" && !a.warmup_enabled);
}
