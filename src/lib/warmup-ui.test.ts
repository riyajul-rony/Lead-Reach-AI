import { describe, it, expect } from "vitest";
import {
  getWarmupDailyTarget,
  getWarmupStatusPillLabel,
  getWarmupStateKey,
  getActiveAccountsWithWarmupOff,
  getReplyCapabilityInfo,
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

  it("returns clear reply detection capability badge and IMAP tooltip explanation", () => {
    const working = getReplyCapabilityInfo({
      id: "1",
      status: "active",
      has_reply_detection: true,
    });
    expect(working.capable).toBe(true);
    expect(working.badgeLabel).toBe("SMTP + IMAP reply detection working");
    expect(working.tooltipContent).toContain("IMAP");

    const missingImap = getReplyCapabilityInfo({
      id: "2",
      status: "active",
      has_reply_detection: false,
    });
    expect(missingImap.capable).toBe(false);
    expect(missingImap.badgeLabel).toBe("Reply detection unavailable (IMAP not configured)");
    expect(missingImap.tooltipContent).toContain("Warm-up replies and stop-on-reply need IMAP");
  });
});
