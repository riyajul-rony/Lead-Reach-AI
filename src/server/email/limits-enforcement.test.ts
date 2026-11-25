import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { saveCampaignSequence, sendSingleRecipientFollowup } from "@/server/email/sequence-service";

const { sentMailMock } = vi.hoisted(() => ({
  sentMailMock: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: async (mailOptions: any) => {
        sentMailMock(mailOptions);
        return { messageId: `<mock-${Date.now()}@company.com>`, accepted: [mailOptions.to] };
      },
      close: vi.fn(),
    })),
  },
}));

describe("Limits Enforcement: Warmup Daily Limits & Plan Limits (Initial + Follow-up)", () => {
  beforeEach(() => {
    sentMailMock.mockClear();
  });

  it("enforces warmup_day-based per-account daily limit for BOTH initial emails and follow-ups", async () => {
    const userId = "user-warmup-limit-1";
    const now = new Date();

    // Warmup Day 1: warmup_start_limit = 2, daily_limit = 150 -> effective daily cap is 2!
    const acc = await db.email_accounts.create({
      data: {
        id: "acc-warmup-cap-2",
        user_id: userId,
        provider: "smtp",
        label: "Warmup Cap 2",
        from_name: "Alex",
        from_email: "warmup2@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "warmup2@company.com",
        smtp_password_enc: encrypt("app-pass"),
        imap_host: "imap.company.com",
        imap_port: 993,
        imap_username: "warmup2@company.com",
        imap_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        warmup_enabled: true,
        warmup_day: 1,
        warmup_start_limit: 2,
        warmup_daily_increment: 5,
        warmup_max_limit: 50,
        status: "active",
      },
    });

    const campaign = await db.outreach_campaigns.create({
      data: {
        id: "camp-warmup-limit",
        user_id: userId,
        name: "Warmup Limit Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
      },
    });

    await saveCampaignSequence(userId, campaign.id, "Seq", [
      { step_no: 1, delay_days: 1, mode: "custom", subject_template: "Re: Hi", body_template: "Follow-up" },
    ]);

    // Seed 2 emails already sent today on this account (reaching warmup Day 1 cap of 2)
    for (let i = 0; i < 2; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: acc.id,
          direction: "out",
          kind: "initial",
          step_no: 0,
          message_id: `<seeded-today-${i}-${Date.now()}@company.com>`,
          status: "sent",
          sent_at: now,
        },
      });
    }

    const initialRec = await db.campaign_recipients.create({
      data: {
        id: "rec-warmup-init",
        user_id: userId,
        campaign_id: campaign.id,
        email: "initcap@target.com",
        assigned_account_id: acc.id,
        status: "queued",
        current_step: 0,
        unsubscribe_token: "tok-warmup-init-123456",
      },
    });

    const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
    const followupRec = await db.campaign_recipients.create({
      data: {
        id: "rec-warmup-fu",
        user_id: userId,
        campaign_id: campaign.id,
        email: "fucap@target.com",
        assigned_account_id: acc.id,
        status: "sent",
        current_step: 0,
        sent_at: threeDaysAgo,
        last_sent_at: threeDaysAgo,
        unsubscribe_token: "tok-warmup-fu-123456",
      },
    });

    const initRes = await sendSingleRecipientEmail(initialRec.id);
    expect(initRes).toHaveProperty("throttled", true);
    expect((initRes as any).reason).toContain("Daily warmup limit reached");

    const fuRes = await sendSingleRecipientFollowup(followupRec.id, now);
    expect(fuRes).toHaveProperty("throttled", true);
    expect((fuRes as any).reason).toContain("Daily warmup limit reached");

    expect(sentMailMock).not.toHaveBeenCalled();
  });

  it("enforces daily_outreach_emails and monthly_outreach_emails plan limits for BOTH initial emails and follow-ups", async () => {
    const userId = "user-plan-limit-1";
    const now = new Date();

    await db.users.create({
      data: {
        id: userId,
        email: "planlimit@company.com",
        name: "Plan Limit User",
        plan: "free",
      },
    });

    // Enforce tight daily_outreach_emails = 1 via user_limit_overrides
    await db.user_limit_overrides.create({
      data: {
        user_id: userId,
        daily_outreach_emails: 1,
        monthly_outreach_emails: 10,
      },
    });

    const acc = await db.email_accounts.create({
      data: {
        id: "acc-plan-limit-1",
        user_id: userId,
        provider: "smtp",
        label: "Plan Limit SMTP",
        from_name: "Alex",
        from_email: "planlimit@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "planlimit@company.com",
        smtp_password_enc: encrypt("app-pass"),
        imap_host: "imap.company.com",
        imap_port: 993,
        imap_username: "planlimit@company.com",
        imap_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        status: "active",
      },
    });

    const campaign = await db.outreach_campaigns.create({
      data: {
        id: "camp-plan-limit",
        user_id: userId,
        name: "Plan Limit Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
      },
    });

    await saveCampaignSequence(userId, campaign.id, "Seq", [
      { step_no: 1, delay_days: 1, mode: "custom", subject_template: "Re: Hi", body_template: "Follow-up" },
    ]);

    // Seed 1 outbound email sent today -> daily_outreach_emails quota (1/1) is now exhausted
    await db.email_messages.create({
      data: {
        user_id: userId,
        email_account_id: acc.id,
        direction: "out",
        kind: "initial",
        step_no: 0,
        message_id: `<plan-used-1-${Date.now()}@company.com>`,
        status: "sent",
        sent_at: now,
      },
    });

    const initialRec = await db.campaign_recipients.create({
      data: {
        id: "rec-plan-init",
        user_id: userId,
        campaign_id: campaign.id,
        email: "planinit@target.com",
        assigned_account_id: acc.id,
        status: "queued",
        current_step: 0,
        unsubscribe_token: "tok-plan-init-123456",
      },
    });

    const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
    const followupRec = await db.campaign_recipients.create({
      data: {
        id: "rec-plan-fu",
        user_id: userId,
        campaign_id: campaign.id,
        email: "planfu@target.com",
        assigned_account_id: acc.id,
        status: "sent",
        current_step: 0,
        sent_at: threeDaysAgo,
        last_sent_at: threeDaysAgo,
        unsubscribe_token: "tok-plan-fu-123456",
      },
    });

    const initRes = await sendSingleRecipientEmail(initialRec.id);
    expect(initRes).toHaveProperty("skipped", true);
    expect((initRes as any).reason).toContain("Plan quota exceeded");

    const fuRes = await sendSingleRecipientFollowup(followupRec.id, now);
    expect(fuRes).toHaveProperty("skipped", true);
    expect((fuRes as any).reason).toContain("Plan quota exceeded");

    expect(sentMailMock).not.toHaveBeenCalled();
  });
});
