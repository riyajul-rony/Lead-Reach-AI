import { describe, it, expect } from "vitest";
import {
  getWarmupDailyTarget,
  getWarmupStatusPillLabel,
  getWarmupStateKey,
  getActiveAccountsWithWarmupOff,
} from "./warmup-ui";

describe("warmup-ui helpers", () => {
  it("computes status pill label for warming vs off accounts", () => {
    expect(getWarmupStatusPillLabel({ id: "1", status: "active", warmup_enabled: false })).toBe(
      "Warm-up Off"
    );
    expect(
      getWarmupStatusPillLabel({
        id: "1",
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 10,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
      })
    ).toBe("Warming 10/day");

    expect(
      getWarmupDailyTarget({
        id: "1",
        status: "active",
        warmup_enabled: true,
        warmup_day: 3,
        warmup_start_limit: 10,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
      })
    ).toBe(20);
  });

  it("changes state key when warmup_enabled or status changes even with identical account count", () => {
    const before = [
      { id: "a", status: "active", warmup_enabled: false },
      { id: "b", status: "active", warmup_enabled: false },
    ];
    const afterToggle = [
      { id: "a", status: "active", warmup_enabled: true },
      { id: "b", status: "active", warmup_enabled: false },
    ];
    const afterPause = [
      { id: "a", status: "paused", warmup_enabled: true },
      { id: "b", status: "active", warmup_enabled: false },
    ];

    expect(getWarmupStateKey(before)).not.toBe(getWarmupStateKey(afterToggle));
    expect(getWarmupStateKey(afterToggle)).not.toBe(getWarmupStateKey(afterPause));
  });

  it("identifies active accounts with warm-up off for one-click pool activation", () => {
    const accounts = [
      { id: "1", status: "active", warmup_enabled: true },
      { id: "2", status: "active", warmup_enabled: false },
      { id: "3", status: "paused", warmup_enabled: false },
    ];
    const targets = getActiveAccountsWithWarmupOff(accounts);
    expect(targets.map((a) => a.id)).toEqual(["2"]);
  });
});
