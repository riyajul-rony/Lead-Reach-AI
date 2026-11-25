import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/server/db";
import { incrementWarmupDayForActiveAccounts, getEffectiveAccountDailyLimit } from "./account-service";

describe("HIGH-01: Warmup Day Increment & Maintenance Automation", () => {
  const testUserId = "00000000-0000-0000-0000-000000000001";

  beforeEach(async () => {
    // Clean up test email accounts
    const existing = await db.email_accounts.findMany({
      where: { user_id: testUserId },
      select: { id: true },
    });
    for (const acc of existing) {
      await db.email_accounts.delete({ where: { id: acc.id } }).catch(() => null);
    }
  });

  it("calculates effective daily limit accurately as warmup days increase", () => {
    const acc = {
      daily_limit: 100,
      warmup_enabled: true,
      warmup_day: 1,
      warmup_start_limit: 10,
      warmup_daily_increment: 5,
      warmup_max_limit: 50,
    };

    expect(getEffectiveAccountDailyLimit(acc)).toBe(10); // Day 1: 10
    expect(getEffectiveAccountDailyLimit({ ...acc, warmup_day: 2 })).toBe(15); // Day 2: 15
    expect(getEffectiveAccountDailyLimit({ ...acc, warmup_day: 9 })).toBe(50); // Day 9: 10 + 8*5 = 50 (capped at max 50)
    expect(getEffectiveAccountDailyLimit({ ...acc, warmup_day: 20 })).toBe(50); // Day 20: still 50
  });

  it("increments warmup_day by 1 for accounts with warmup_enabled=true", async () => {
    const acc = await db.email_accounts.create({
      data: {
        user_id: testUserId,
        from_email: "warmup1@example.com",
        label: "Warmup Test 1",
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 10,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
        warmup_last_incremented_at: null,
      },
    });

    const now = new Date("2026-11-14T02:00:00.000Z");
    const result = await incrementWarmupDayForActiveAccounts(now);

    expect(result.incremented).toBeGreaterThanOrEqual(1);

    const updated = await db.email_accounts.findUnique({ where: { id: acc.id } });
    expect(updated?.warmup_day).toBe(2);
    expect(updated?.warmup_last_incremented_at).toBeDefined();
  });

  it("is idempotent when run twice on the same calendar day", async () => {
    const acc = await db.email_accounts.create({
      data: {
        user_id: testUserId,
        from_email: "warmup_idempotent@example.com",
        label: "Warmup Idempotent Test",
        status: "active",
        warmup_enabled: true,
        warmup_day: 3,
        warmup_start_limit: 10,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
        warmup_last_incremented_at: null,
      },
    });

    const now = new Date("2026-11-14T02:00:00.000Z");
    // Run 1
    const res1 = await incrementWarmupDayForActiveAccounts(now);
    expect(res1.incremented).toBeGreaterThanOrEqual(1);

    const afterRun1 = await db.email_accounts.findUnique({ where: { id: acc.id } });
    expect(afterRun1?.warmup_day).toBe(4);

    // Run 2 (e.g. worker restarts on same day at 04:00)
    const run2Time = new Date("2026-11-14T04:30:00.000Z");
    const res2 = await incrementWarmupDayForActiveAccounts(run2Time);

    const afterRun2 = await db.email_accounts.findUnique({ where: { id: acc.id } });
    expect(afterRun2?.warmup_day).toBe(4); // Stays 4, did NOT increment again!
  });

  it("caps warmup_day when maximum limit is reached", async () => {
    // start=10, inc=10, max=30 -> day 1=10, day 2=20, day 3=30 (maxDays = 3)
    const acc = await db.email_accounts.create({
      data: {
        user_id: testUserId,
        from_email: "warmup_capped@example.com",
        label: "Warmup Capped Test",
        status: "active",
        warmup_enabled: true,
        warmup_day: 3,
        warmup_start_limit: 10,
        warmup_daily_increment: 10,
        warmup_max_limit: 30,
        warmup_last_incremented_at: null,
      },
    });

    const now = new Date("2026-11-14T02:00:00.000Z");
    const result = await incrementWarmupDayForActiveAccounts(now);

    const updated = await db.email_accounts.findUnique({ where: { id: acc.id } });
    expect(updated?.warmup_day).toBe(3); // Capped at 3, does not increment beyond max
  });
});
