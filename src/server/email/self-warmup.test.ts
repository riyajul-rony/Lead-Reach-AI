import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRemoveJobScheduler } = vi.hoisted(() => ({
  mockRemoveJobScheduler: vi.fn().mockResolvedValue(true),
}));

vi.mock("bullmq", () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    upsertJobScheduler = vi.fn().mockResolvedValue({ id: "mock" });
    add = vi.fn().mockResolvedValue({ id: "mock-job" });
    removeJobScheduler = mockRemoveJobScheduler;
  }
  return {
    Queue: MockQueue,
    Worker: class MockWorker {},
  };
});

import { db } from "@/server/db";
import { stripAppPasswordSpaces } from "@/components/warmup/gmail-app-password-guide";
import { localDevStore } from "@/test/local-store";
import {
  WARMUP_HEADER,
  WARMUP_ID_HEADER,
  WARMUP_REPLY_HEADER,
  WARMUP_ACCOUNT_SELECT,
  handleIncomingWarmupEmail,
  runSelfWarmupTick,
} from "@/server/email/warmup-pool-service";
import { registerRepeatableSchedulers } from "@/server/queues";

describe("Phase 3 Step 5: Self Warm-up Pool", () => {
  const prevSchedulers = process.env.SCHEDULERS_ENABLED;

  beforeEach(() => {
    delete process.env.SCHEDULERS_ENABLED;
  });

  afterEach(() => {
    process.env.SCHEDULERS_ENABLED = prevSchedulers;
    vi.restoreAllMocks();
  });

  it("1. Skips users with fewer than 2 active warmup_enabled accounts", async () => {
    const userId = `u-wu-single-${Date.now()}`;
    await db.email_accounts.create({
      data: {
        id: `acc-single-${Date.now()}`,
        user_id: userId,
        provider: "smtp",
        label: "Only Inbox",
        from_email: `only-${Date.now()}@domain.com`,
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 10,
      },
    });

    const spy = vi.fn(async () => ({ messageId: "<mock>" }));
    const result = await runSelfWarmupTick(spy);

    expect(result.usersSkippedBelowMin).toBeGreaterThanOrEqual(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("2. Sends between user's own >=2 active warmup accounts, prefers IMAP receivers, and respects warmup_day limits", async () => {
    const uid = `u-wu-pool-${Date.now()}`;
    const accNoImap = await db.email_accounts.create({
      data: {
        id: `acc-a-${Date.now()}`,
        user_id: uid,
        provider: "gmail_api",
        label: "OAuth Sender",
        from_email: `sender-${Date.now()}@gmail.com`,
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 2, // Very small Day 1 cap for testing
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
        hourly_limit: 25,
      },
    });
    const accWithImap = await db.email_accounts.create({
      data: {
        id: `acc-b-${Date.now()}`,
        user_id: uid,
        provider: "smtp",
        label: "IMAP Receiver",
        from_email: `receiver-${Date.now()}@company.com`,
        imap_host: "imap.gmail.com",
        imap_password_enc: "enc-pass",
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 10,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
        hourly_limit: 25,
      },
    });

    const beforeMessages = localDevStore.getEmailMessages().length;
    const beforeRecipients = localDevStore.getRecipients().length;

    const sentPayloads: any[] = [];
    const transportMock = vi.fn(async (input: any) => {
      sentPayloads.push(input);
      return { messageId: input.explicitMessageId };
    });

    // Tick 1: accNoImap sends 1 (preferred receiver is accWithImap), accWithImap sends 1 -> 2 sent
    const res1 = await runSelfWarmupTick(transportMock);
    expect(res1.emailsSent).toBeGreaterThanOrEqual(2);

    // Check warmup headers and campaign isolation
    const fromFirst = sentPayloads.find((p) => p.account.id === accNoImap.id);
    expect(fromFirst.to).toBe(accWithImap.from_email);
    expect(fromFirst.headers[WARMUP_HEADER]).toBe("true");
    expect(fromFirst.headers[WARMUP_ID_HEADER]).toBeTruthy();
    expect(localDevStore.getEmailMessages().length).toBe(beforeMessages);
    expect(localDevStore.getRecipients().length).toBe(beforeRecipients);

    // Pre-fill outreach count on accNoImap so sentToday (1 warmup + 1 outreach = 2) reaches dailyCap=2
    await db.email_messages.create({
      data: {
        user_id: uid,
        email_account_id: accNoImap.id,
        direction: "out",
        kind: "initial",
        step_no: 0,
        message_id: `<out-${Date.now()}@gmail.com>`,
        status: "sent",
        sent_at: new Date(),
      },
    });

    sentPayloads.length = 0;
    const res2 = await runSelfWarmupTick(transportMock);
    // accNoImap must be throttled and NOT send again
    expect(sentPayloads.some((p) => p.account.id === accNoImap.id)).toBe(false);
    expect(res2.throttled).toBeGreaterThanOrEqual(1);
  });

  it("3. Replies strictly ONCE per warmup thread and prevents infinite ping-pong loops", async () => {
    const uid = `u-wu-loop-${Date.now()}`;
    const fromAcc = await db.email_accounts.create({
      data: {
        id: `acc-from-${Date.now()}`,
        user_id: uid,
        provider: "smtp",
        label: "From",
        from_email: `from-${Date.now()}@test.com`,
        status: "active",
        warmup_enabled: true,
        daily_limit: 50,
        hourly_limit: 25,
      },
    });
    const toAcc = await db.email_accounts.create({
      data: {
        id: `acc-to-${Date.now()}`,
        user_id: uid,
        provider: "smtp",
        label: "To",
        from_email: `to-${Date.now()}@test.com`,
        status: "active",
        warmup_enabled: true,
        daily_limit: 50,
        hourly_limit: 25,
      },
    });

    const logId = `wu-log-${Date.now()}`;
    await db.warmup_logs.create({
      data: {
        id: logId,
        user_id: uid,
        from_account_id: fromAcc.id,
        to_account_id: toAcc.id,
        message_id: `<warmup-${logId}@test.com>`,
        subject: "Quick check-in",
        status: "sent",
        sent_at: new Date(),
      },
    });

    const repliesSent: any[] = [];
    const replyTransport = vi.fn(async (input: any) => {
      repliesSent.push(input);
      return { messageId: input.explicitMessageId };
    });

    // First arrival at receiving inbox triggers ONE reply tagged with WARMUP_REPLY_HEADER
    const first = await handleIncomingWarmupEmail(
      {
        receivingAccount: toAcc,
        fromAddress: fromAcc.from_email,
        messageId: `<warmup-${logId}@test.com>`,
        subject: "Quick check-in",
        headers: new Map([
          [WARMUP_HEADER.toLowerCase(), "true"],
          [WARMUP_ID_HEADER.toLowerCase(), logId],
        ]),
      },
      replyTransport
    );
    expect(first).toEqual({ handled: true, replied: true });
    expect(repliesSent).toHaveLength(1);
    expect(repliesSent[0].headers[WARMUP_REPLY_HEADER]).toBe("true");

    // Duplicate poll of same message does NOT reply again (status is now "replied")
    const second = await handleIncomingWarmupEmail(
      {
        receivingAccount: toAcc,
        fromAddress: fromAcc.from_email,
        messageId: `<warmup-${logId}@test.com>`,
        subject: "Quick check-in",
        headers: new Map([
          [WARMUP_HEADER.toLowerCase(), "true"],
          [WARMUP_ID_HEADER.toLowerCase(), logId],
        ]),
      },
      replyTransport
    );
    expect(second).toEqual({
      handled: true,
      replied: false,
      reason: "already_replied",
    });

    // When reply arrives back at sender inbox with X-LeadReachAI-Warmup-Reply: true, NEVER reply!
    const bounceBack = await handleIncomingWarmupEmail(
      {
        receivingAccount: fromAcc,
        fromAddress: toAcc.from_email,
        messageId: `<warmup-reply-${logId}@test.com>`,
        subject: "Re: Quick check-in",
        headers: new Map([
          [WARMUP_HEADER.toLowerCase(), "true"],
          [WARMUP_REPLY_HEADER.toLowerCase(), "true"],
          [WARMUP_ID_HEADER.toLowerCase(), logId],
        ]),
      },
      replyTransport
    );
    expect(bounceBack).toEqual({
      handled: true,
      replied: false,
      reason: "already_reply",
    });
    expect(repliesSent).toHaveLength(1);
  });

  it("4. Removes leadreach:scheduler:warmup when SCHEDULERS_ENABLED is false", async () => {
    process.env.SCHEDULERS_ENABLED = "false";
    mockRemoveJobScheduler.mockClear();

    const res = await registerRepeatableSchedulers();
    expect(res.registered).toBe(false);
    expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:warmup");
  });

  it("5. Strips whitespace from pasted Gmail App Passwords before testing/saving", () => {
    expect(stripAppPasswordSpaces("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(stripAppPasswordSpaces(" abcd\tefgh\nijkl mnop ")).toBe("abcdefghijklmnop");
  });

  it("6. Selects all adaptive limit fields and surfaces warm-up transport errors on email_accounts.last_error", async () => {
    expect(WARMUP_ACCOUNT_SELECT.account_type).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.workspace_tier).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.detected_age_days).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.ramp_started_at).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.healthy_weeks_completed).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.user_daily_limit).toBe(true);
    expect(WARMUP_ACCOUNT_SELECT.admin_daily_limit_override).toBe(true);

    const uid = `u-wu-err-${Date.now()}`;
    const fromAcc = await db.email_accounts.create({
      data: {
        id: `acc-err-1-${Date.now()}`,
        user_id: uid,
        provider: "smtp",
        label: "Err Sender",
        from_email: `err1-${Date.now()}@domain.com`,
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 5,
        hourly_limit: 25,
      },
    });
    await db.email_accounts.create({
      data: {
        id: `acc-err-2-${Date.now()}`,
        user_id: uid,
        provider: "smtp",
        label: "Err Receiver",
        from_email: `err2-${Date.now()}@domain.com`,
        status: "active",
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 5,
        hourly_limit: 25,
        imap_host: "imap.domain.com",
        imap_password_enc: "enc",
      },
    });

    const failingSpy = vi.fn(async () => {
      throw new Error("SMTP connection refused");
    });

    const res = await runSelfWarmupTick(failingSpy);
    expect(res.failed).toBeGreaterThanOrEqual(1);

    const updatedFrom = await db.email_accounts.findUnique({ where: { id: fromAcc.id } });
    expect(updatedFrom?.last_error).toContain("SMTP connection refused");
  });
});
