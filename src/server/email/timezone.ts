export interface SendingWindowOptions {
  timezone?: string | null;
  startHour?: number | null;
  endHour?: number | null;
  daysOfWeek?: number[] | null;
}

/**
 * Validates whether a string is a recognized IANA timezone identifier (e.g. "America/New_York", "UTC").
 */
export function isValidIanaTimezone(tz?: string | null): boolean {
  if (!tz || typeof tz !== "string") return false;
  const trimmed = tz.trim();
  if (!trimmed || trimmed.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the trimmed timezone if valid, or null when absent/invalid.
 */
export function normalizeIanaTimezone(tz?: string | null): string | null {
  if (!isValidIanaTimezone(tz)) return null;
  return tz!.trim();
}

/**
 * Resolves the effective sending timezone for a recipient:
 * 1. Recipient/lead timezone (if present & valid IANA)
 * 2. Campaign timezone (if present & valid IANA)
 * 3. Sender account timezone (if present & valid IANA)
 * 4. "UTC" fallback
 */
export function resolveEffectiveSendingTimezone(opts: {
  recipientTimezone?: string | null;
  campaignTimezone?: string | null;
  accountTimezone?: string | null;
}): string {
  return (
    normalizeIanaTimezone(opts.recipientTimezone) ||
    normalizeIanaTimezone(opts.campaignTimezone) ||
    normalizeIanaTimezone(opts.accountTimezone) ||
    "UTC"
  );
}

/**
 * Parses local date/time components (weekday, hour, minute) in an IANA timezone with UTC fallback.
 */
export function getLocalTimeParts(
  date: Date,
  timezone = "UTC"
): { weekdayNum: number; hour: number; minute: number } {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(date);
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value || "Mon";
    const hourStr = parts.find((p) => p.type === "hour")?.value || "0";
    const minuteStr = parts.find((p) => p.type === "minute")?.value || "0";

    const dayMap: Record<string, number> = {
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
      Sun: 7,
    };
    const weekdayNum = dayMap[weekdayStr] || 1;
    const rawHour = parseInt(hourStr, 10);
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = parseInt(minuteStr, 10) || 0;

    return { weekdayNum, hour, minute };
  } catch {
    const day = date.getUTCDay();
    return {
      weekdayNum: day === 0 ? 7 : day,
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
}

/**
 * Checks whether the current time falls inside the active days and working hours for the target timezone.
 */
export function isWithinSendingWindow(date: Date, options: SendingWindowOptions): boolean {
  const safeTz = normalizeIanaTimezone(options.timezone) || "UTC";
  const { weekdayNum, hour } = getLocalTimeParts(date, safeTz);

  const activeDays =
    options.daysOfWeek && options.daysOfWeek.length > 0 ? options.daysOfWeek : [1, 2, 3, 4, 5];

  // Match 1..7 or 0 (0 and 7 both represent Sunday)
  const isDayAllowed = activeDays.some((d) => d === weekdayNum || (weekdayNum === 7 && d === 0));
  if (!isDayAllowed) {
    return false;
  }

  const start = options.startHour !== undefined && options.startHour !== null ? options.startHour : 9;
  const end = options.endHour !== undefined && options.endHour !== null ? options.endHour : 18;

  return hour >= start && hour < end;
}
