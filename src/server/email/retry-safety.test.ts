import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { localDevStore } from "@/test/local-store";
import { encrypt } from "@/server/crypto";
import {
  saveCampaignSequence,
  sendSingleRecipientFollowup,
  dispatchDueFollowups,
} from "@/server/email/sequence-service";
import {
  sendSingleRecipientEmail,
  recoverStuckSendingRecipients,
} from "@/server/email/sending-engine";
import * as RetryRoute from "@/app/api/v1/outreach/campaigns/[id]/retry/route";

const { sentMailMock, mockSession } = vi.hoisted(() => ({
  sentMailMock: vi.fn(),
  mockSession: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: async (mailOptions: any) => {
        sentMailMock(mailOptions);
        return {
          messageId: `<mock-${Date.now()}@leadreach.io>`,
          accepted: [mailOptions.to],
        };
      },
      close: vi.fn(),
    })),
  },
}));

vi.mock("@/server/queues", () => ({
  queueEmailDispatch: vi.fn().mockResolvedValue(true),
  queueEmailSend: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

describe("Retry Safety & Duplicate-Step Prevention", () => {
  const userId = "user-retry-safety-1";

  beforeEach(() => {
    sentMailMock.mockClear();
    mockSession.mockResolvedValue({ user: { id: userId, email: "owner@company.com" } });
  });

  it("restores stale follow-up needs_review recipients to 'sent' (never 'queued') and dispatches only the NEXT step while respecting delays & reply detection", async () => {
    const account = await db.email_accounts.create({
      data: {
        id: "acc-retry-safe-1",
        user_id: userId,
        provider: "smtp",
        label: "Retry Safe SMTP",
        from_name: "Alex",
        from_email: "alex@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "alex@company.com",
        smtp_password_enc: encrypt("app-pass"),
        imap_host: "imap.company.com",
        imap_port: 993,
        imap_username: "alex@company.com",
        imap_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        status: "active",
      },
    });

    const campaign = await db.outreach_campaigns.create({
      data: {
        id: "camp-retry-safe-1",
        user_id: userId,
        name: "Retry Safety Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
        send_window: { startHour: 0, endHour: 24 },
        days_of_week: [0, 1, 2, 3, 4, 5, 6],
        subject_template: "Initial Outreach",
        body_template: "Hi, initial message.",
      },
    });

    await saveCampaignSequence(userId, campaign.id, "2-Step Seq", [
      {
        step_no: 1,
        delay_days: 2,
        mode: "custom",
        subject_template: "Re: {{previous_subject}}",
        body_template: "Follow-up Step 1 body.",
      },
      {
        step_no: 2,
        delay_days: 3,
        mode: "custom",
        subject_template: "Re: {{previous_subject}}",
        body_template: "Follow-up Step 2 final body.",
      },
    ]);

    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000);

    // Lead A: Already received Step 1 (current_step: 1), Step 2 became stale -> marked needs_review
    const staleFollowupRec = await db.campaign_recipients.create({
      data: {
        id: "rec-stale-step1",
        user_id: userId,
        campaign_id: campaign.id,
        email: "step1done@target.com",
        assigned_account_id: account.id,
        status: "sent",
        current_step: 1,
        sent_at: fiveDaysAgo,
        last_sent_at: threeDaysAgo,
        next_followup_at: threeDaysAgo, // overdue (> 24h)
        generated_subject: "Initial Outreach",
        thread_message_id: "<orig-thread-1@company.com>",
        unsubscribe_token: "tok-retry-step1-done-123456",
      },
    });

    // Lead B: Never received initial email -> marked needs_review
    const staleInitialRec = await db.campaign_recipients.create({
      data: {
        id: "rec-stale-initial",
        user_id: userId,
        campaign_id: campaign.id,
        email: "neversent@target.com",
        assigned_account_id: account.id,
        status: "needs_review",
        current_step: 0,
        sent_at: null,
        last_sent_at: null,
        unsubscribe_token: "tok-retry-initial-123456",
      },
    });

    // Trigger stale catch-up on Lead A
    await dispatchDueFollowups(new Date());
    const afterStale = await db.campaign_recipients.findUnique({ where: { id: staleFollowupRec.id } });
    expect(afterStale?.status).toBe("needs_review");

    // Call POST /api/v1/outreach/campaigns/:id/retry
    const req = new NextRequest(`http://localhost:3000/api/v1/outreach/campaigns/${campaign.id}/retry`, {
      method: "POST",
    });
    const res = await RetryRoute.POST(req, { params: Promise.resolve({ id: campaign.id }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.retriedCount).toBe(2);
    expect(json.initialRequeued).toBe(1);
    expect(json.followupsRestored).toBe(1);

    // Lead A MUST be restored to 'sent' with current_step still 1 (NEVER 'queued'!)
    const restoredFollowupRec = await db.campaign_recipients.findUnique({ where: { id: staleFollowupRec.id } });
    expect(restoredFollowupRec?.status).toBe("sent");
    expect(restoredFollowupRec?.current_step).toBe(1);
    expect(restoredFollowupRec?.error).toBeNull();

    // Lead B MUST be moved to 'queued'
    const restoredInitialRec = await db.campaign_recipients.findUnique({ where: { id: staleInitialRec.id } });
    expect(restoredInitialRec?.status).toBe("queued");
    expect(restoredInitialRec?.current_step).toBe(0);

    // Ensure delay check is STILL respected if last_sent_at was only 1 day ago (Step 2 delay is 3 days)
    const oneDayAfterStep1 = new Date(threeDaysAgo.getTime() + 1 * 86400000);
    const earlyCheck = await sendSingleRecipientFollowup(staleFollowupRec.id, oneDayAfterStep1);
    expect(earlyCheck).toHaveProperty("skipped", true);
    expect((earlyCheck as any).reason).toContain("due at");
    expect(sentMailMock).not.toHaveBeenCalled();

    // Now dispatch follow-ups at current time (3+ days later) -> MUST send Step 2 ONLY (not initial, not step 1)
    await dispatchDueFollowups(new Date());
    expect(sentMailMock).toHaveBeenCalledTimes(1);
    const mailCall = sentMailMock.mock.calls[0][0];
    expect(mailCall.to).toBe("step1done@target.com");
    expect(mailCall.text).toContain("Follow-up Step 2 final body.");
    expect(mailCall.text).not.toContain("Follow-up Step 1 body.");
    expect(mailCall.text).not.toContain("Hi, initial message.");
    expect(mailCall.headers["X-LeadReachAI-Step-No"]).toBe("2");

    // Verify recipient is now at step 2 with no remaining follow-up
    const afterStep2 = await db.campaign_recipients.findUnique({ where: { id: staleFollowupRec.id } });
    expect(afterStep2?.current_step).toBe(2);
    expect(afterStep2?.next_followup_at).toBeNull();
  });

  it("never sends the same follow-up step twice even if current_step was not incremented or retry is re-run", async () => {
    const account = await db.email_accounts.create({
      data: {
        id: "acc-dup-step-1",
        user_id: userId,
        provider: "smtp",
        label: "Dup Step SMTP",
        from_name: "Alex",
        from_email: "alex2@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "alex2@company.com",
        smtp_password_enc: encrypt("app-pass"),
        imap_host: "imap.company.com",
        imap_port: 993,
        imap_username: "alex2@company.com",
        imap_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        status: "active",
      },
    });

    const campaign = await db.outreach_campaigns.create({
      data: {
        id: "camp-dup-step-1",
        user_id: userId,
        name: "No Duplicate Step Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
        send_window: { startHour: 0, endHour: 24 },
      },
    });

    await saveCampaignSequence(userId, campaign.id, "Seq", [
      {
        step_no: 1,
        delay_days: 1,
        mode: "custom",
        subject_template: "Re: Hello",
        body_template: "Step 1 body",
      },
      {
        step_no: 2,
        delay_days: 1,
        mode: "custom",
        subject_template: "Re: Hello",
        body_template: "Step 2 body",
      },
    ]);

    const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
    const rec = await db.campaign_recipients.create({
      data: {
        id: "rec-dup-step",
        user_id: userId,
        campaign_id: campaign.id,
        email: "nodup@target.com",
        assigned_account_id: account.id,
        status: "sent",
        current_step: 1, // Simulates partial failure: current_step still 1, even though Step 2 already exists in email_messages
        sent_at: threeDaysAgo,
        last_sent_at: threeDaysAgo,
        next_followup_at: threeDaysAgo,
        unsubscribe_token: "tok-nodup-12345678901234",
      },
    });

    // Record that Step 2 was ALREADY sent in email_messages
    await db.email_messages.create({
      data: {
        user_id: userId,
        recipient_id: rec.id,
        email_account_id: account.id,
        direction: "out",
        kind: "followup",
        step_no: 2,
        message_id: "<step2-already-sent@company.com>",
        status: "sent",
        sent_at: threeDaysAgo,
      },
    });

    const res = await sendSingleRecipientFollowup(rec.id, new Date());
    expect(res).toHaveProperty("skipped", true);
    expect((res as any).reason).toContain("already sent");
    expect(sentMailMock).not.toHaveBeenCalled();

    // Also verify sendSingleRecipientEmail refuses to resend initial email if sent_at is set
    const recInitialDone = await db.campaign_recipients.create({
      data: {
        id: "rec-initial-already-done",
        user_id: userId,
        campaign_id: campaign.id,
        email: "initialdone@target.com",
        assigned_account_id: account.id,
        status: "queued",
        current_step: 0,
        sent_at: threeDaysAgo,
        unsubscribe_token: "tok-initdone-1234567890",
      },
    });
    const initRes = await sendSingleRecipientEmail(recInitialDone.id);
    expect(initRes).toHaveProperty("skipped", true);
    expect(sentMailMock).not.toHaveBeenCalled();
  });

  it("recovers stuck 'sending' recipients after 15m into 'needs_review' without auto-resending, and prevents double-send on BullMQ retry after partial failure", async () => {
    const account = await db.email_accounts.create({
      data: {
        id: "acc-stuck-sending-1",
        user_id: userId,
        provider: "smtp",
        label: "Stuck Test SMTP",
        from_name: "Alex",
        from_email: "alex-stuck@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "alex-stuck@company.com",
        smtp_password_enc: encrypt("app-pass"),
        imap_host: "imap.company.com",
        imap_port: 993,
        imap_username: "alex-stuck@company.com",
        imap_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        status: "active",
      },
    });

    const campaign = await db.outreach_campaigns.create({
      data: {
        id: "camp-stuck-sending-1",
        user_id: userId,
        name: "Stuck Sending Test",
        mode: "custom",
        status: "running",
        timezone: "UTC",
        send_window: { startHour: 0, endHour: 24 },
      },
    });

    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);

    // Crashed worker left recipient in 'sending' 20 minutes ago
    const stuckRec = await db.campaign_recipients.create({
      data: {
        id: "rec-stuck-20m",
        user_id: userId,
        campaign_id: campaign.id,
        email: "stuck20m@target.com",
        assigned_account_id: account.id,
        status: "sending",
        sending_started_at: twentyMinsAgo,
        current_step: 0,
        unsubscribe_token: "tok-stuck20m-1234567890",
      },
    });

    // Recently claimed recipient in 'sending' 2 minutes ago (still in flight)
    const activeSendingRec = await db.campaign_recipients.create({
      data: {
        id: "rec-inflight-2m",
        user_id: userId,
        campaign_id: campaign.id,
        email: "inflight2m@target.com",
        assigned_account_id: account.id,
        status: "sending",
        sending_started_at: twoMinsAgo,
        current_step: 0,
        unsubscribe_token: "tok-inflight2m-123456789",
      },
    });

    const recoveredCount = await recoverStuckSendingRecipients(campaign.id, new Date());
    expect(recoveredCount).toBe(1);

    const updatedStuck = await db.campaign_recipients.findUnique({ where: { id: stuckRec.id } });
    expect(updatedStuck?.status).toBe("needs_review");
    expect(updatedStuck?.error).toContain("never auto-resend");

    const updatedInFlight = await db.campaign_recipients.findUnique({ where: { id: activeSendingRec.id } });
    expect(updatedInFlight?.status).toBe("sending");

    // Simulate BullMQ retry on an already-claimed 'sending' recipient (crash after SMTP accept, before DB update)
    const retryOnSending = await sendSingleRecipientEmail(activeSendingRec.id);
    expect(retryOnSending).toHaveProperty("skipped", true);
    expect((retryOnSending as any).reason).toContain("only 'queued' can be dispatched");
    expect(sentMailMock).not.toHaveBeenCalled();

    // Simulate partial failure: transport succeeds, DB email_messages.create fails -> must mark needs_review and skip on BullMQ retry
    const partialFailRec = await db.campaign_recipients.create({
      data: {
        id: "rec-partial-fail",
        user_id: userId,
        campaign_id: campaign.id,
        email: "partial@target.com",
        assigned_account_id: account.id,
        status: "queued",
        current_step: 0,
        unsubscribe_token: "tok-partial-1234567890",
      },
    });

    const spyCreate = vi
      .spyOn(localDevStore, "saveEmailMessage")
      .mockImplementationOnce(() => {
        throw new Error("Simulated DB connection drop after SMTP accept");
      });

    const firstAttempt = await sendSingleRecipientEmail(partialFailRec.id);
    spyCreate.mockRestore();

    expect(sentMailMock).toHaveBeenCalledTimes(1);
    expect(firstAttempt).toHaveProperty("partialFailure", true);

    const afterPartial = await db.campaign_recipients.findUnique({ where: { id: partialFailRec.id } });
    expect(afterPartial?.status).toBe("needs_review");
    expect(afterPartial?.thread_message_id).toBeTruthy();

    // BullMQ retry MUST skip without sending a second email
    const secondAttempt = await sendSingleRecipientEmail(partialFailRec.id);
    expect(secondAttempt).toHaveProperty("skipped", true);
    expect(sentMailMock).toHaveBeenCalledTimes(1);
  });
});
