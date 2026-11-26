import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/server/db";
import {
  getDefaultSendJitterBounds,
  resolveAccountJitterBounds,
  computeSendJitterSeconds,
} from "./send-jitter";
import { reserveAccountDailyCapacity, releaseAccountDailyCapacity } from "./daily-capacity";

const { mockQueueEmailSend } = vi.hoisted(() => ({
  mockQueueEmailSend: vi.fn(),
}));

vi.mock("@/server/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queues")>();
  return {
    ...actual,
    queueEmailSend: (...args: any[]) => mockQueueEmailSend(...args),
  };
});

import { dispatchRunningCampaigns } from "./sending-engine";

describe("Task 7 — Per-Account Randomized Send Jitter", () => {
  const origEnv = {
    min: process.env.SEND_JITTER_MIN_SECONDS,
    max: process.env.SEND_JITTER_MAX_SECONDS,
  };
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueEmailSend.mockResolvedValue(true);
    delete process.env.SEND_JITTER_MIN_SECONDS;
    delete process.env.SEND_JITTER_MAX_SECONDS;
  });

  afterEach(() => {
    if (origEnv.min === undefined) delete process.env.SEND_JITTER_MIN_SECONDS;
    else process.env.SEND_JITTER_MIN_SECONDS = origEnv.min;
    if (origEnv.max === undefined) delete process.env.SEND_JITTER_MAX_SECONDS;
    else process.env.SEND_JITTER_MAX_SECONDS = origEnv.max;
  });

  it("defaults to 120–300 seconds and produces randomized non-constant delays", () => {
    const defaults = getDefaultSendJitterBounds();
    expect(defaults).toEqual({ minSeconds: 120, maxSeconds: 300 });

    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const val = computeSendJitterSeconds();
      expect(val).toBeGreaterThanOrEqual(120);
      expect(val).toBeLessThanOrEqual(300);
      seen.add(val);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("supports env-configurable jitter bounds via SEND_JITTER_MIN_SECONDS and SEND_JITTER_MAX_SECONDS", () => {
    process.env.SEND_JITTER_MIN_SECONDS = "90";
    process.env.SEND_JITTER_MAX_SECONDS = "210";

    const resolved = resolveAccountJitterBounds(
      { min_gap_seconds: 120, max_gap_seconds: 300 },
      { jitter_min_sec: 120, jitter_max_sec: 300 }
    );
    expect(resolved).toEqual({ minSeconds: 90, maxSeconds: 210 });

    const sample = computeSendJitterSeconds(resolved.minSeconds, resolved.maxSeconds);
    expect(sample).toBeGreaterThanOrEqual(90);
    expect(sample).toBeLessThanOrEqual(210);
  });

  it("schedules delays independently per sending account via BullMQ without slowing each other down", async () => {
    const userId = uid("user-jitter");
    const now = new Date("2026-11-26T14:00:00.000Z"); // Within 0-24 window

    const accA = await db.email_accounts.create({
      data: {
        id: uid("acc-a"),
        user_id: userId,
        label: "Inbox A",
        from_email: "a@acme.io",
        timezone: "UTC",
        min_gap_seconds: 120,
        max_gap_seconds: 300,
        next_allowed_at: new Date(now.getTime() + 180_000), // A already on 180s cooldown
        status: "active",
      },
    });
    const accB = await db.email_accounts.create({
      data: {
        id: uid("acc-b"),
        user_id: userId,
        label: "Inbox B",
        from_email: "b@acme.io",
        timezone: "UTC",
        min_gap_seconds: 120,
        max_gap_seconds: 300,
        next_allowed_at: null, // B has zero cooldown
        status: "active",
      },
    });

    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-jitter"),
        user_id: userId,
        name: "Multi-Inbox Jitter Campaign",
        subject: "Hi",
        body_template: "Hello",
        status: "running",
        send_window: { startHour: 0, endHour: 24 },
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
        jitter_min_sec: 120,
        jitter_max_sec: 300,
      },
    });

    const recA1 = await db.campaign_recipients.create({
      data: {
        id: uid("rec-a1"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: accA.id,
        email: "a1@target.com",
        status: "queued",
      },
    });
    const recA2 = await db.campaign_recipients.create({
      data: {
        id: uid("rec-a2"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: accA.id,
        email: "a2@target.com",
        status: "queued",
      },
    });
    const recB1 = await db.campaign_recipients.create({
      data: {
        id: uid("rec-b1"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: accB.id,
        email: "b1@target.com",
        status: "queued",
      },
    });
    const recB2 = await db.campaign_recipients.create({
      data: {
        id: uid("rec-b2"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: accB.id,
        email: "b2@target.com",
        status: "queued",
      },
    });

    const result = await dispatchRunningCampaigns(now);
    expect(result.scheduled).toBeGreaterThanOrEqual(4);

    const delaysByRec = new Map<string, number>();
    for (const [recId, delayMs] of mockQueueEmailSend.mock.calls) {
      delaysByRec.set(recId, delayMs);
    }

    const dA1 = delaysByRec.get(recA1.id)!;
    const dA2 = delaysByRec.get(recA2.id)!;
    const dB1 = delaysByRec.get(recB1.id)!;
    const dB2 = delaysByRec.get(recB2.id)!;

    // Account A inherits its 180s cooldown, and second send adds 120-300s jitter
    expect(dA1).toBe(180_000);
    expect(dA2 - dA1).toBeGreaterThanOrEqual(120_000);
    expect(dA2 - dA1).toBeLessThanOrEqual(300_000);

    // Account B starts immediately at 0ms despite Account A's cooldown & delay stack
    expect(dB1).toBe(0);
    expect(dB2 - dB1).toBeGreaterThanOrEqual(120_000);
    expect(dB2 - dB1).toBeLessThanOrEqual(300_000);

    // Clean up campaign so it doesn't interfere if anything else queries running campaigns
    await db.outreach_campaigns.update({ where: { id: camp.id }, data: { status: "paused" } });
  });

  it("keeps daily caps from Task 6 intact alongside jitter configuration", async () => {
    const account = await db.email_accounts.create({
      data: {
        id: uid("acc-cap-jitter"),
        user_id: uid("u-cap-j"),
        label: "Cap Jitter",
        from_email: "cap@gmail.com",
        account_type: "free_gmail",
        user_daily_limit: 5,
        min_gap_seconds: 120,
        max_gap_seconds: 300,
        status: "active",
      },
    });

    const slots = [];
    for (let i = 0; i < 6; i++) {
      slots.push(await reserveAccountDailyCapacity(account));
    }
    expect(slots.filter((s) => s.allowed)).toHaveLength(5);
    expect(slots.filter((s) => !s.allowed)).toHaveLength(1);

    for (const s of slots) {
      if (s.allowed) await releaseAccountDailyCapacity(s.reservation);
    }
  });
});
