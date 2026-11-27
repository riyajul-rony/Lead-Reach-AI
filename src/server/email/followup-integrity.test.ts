import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/server/db";
import { createEmailAccount } from "@/server/email/account-service";
import { createOutreachCampaign, updateCampaignStatus } from "@/server/email/campaign-service";
import { recordWorkspaceLegalAcknowledgement } from "@/server/legal/acknowledgement";

const { mockQueueEmailSend, sentMailMock } = vi.hoisted(() => ({
  mockQueueEmailSend: vi.fn(),
  sentMailMock: vi.fn().mockResolvedValue({ messageId: "<fu-integrity@agency.com>" }),
}));

vi.mock("@/server/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queues")>();
  return {
    ...actual,
    queueEmailSend: (...args: any[]) => mockQueueEmailSend(...args),
  };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: sentMailMock,
      close: vi.fn(),
    }),
  },
}));

import {
  getCampaignSequence,
  saveCampaignSequence,
  dispatchDueFollowups,
} from "@/server/email/sequence-service";

describe("Phase 6c Item 1: Follow-up Canonical Storage & Starvation Fix", () => {
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueEmailSend.mockResolvedValue(true);
    sentMailMock.mockResolvedValue({ messageId: "<fu-integrity@agency.com>" });
  });

  it("creates step 1 exactly once in campaign_steps when creating a campaign and returns empty sequence when unconfigured", async () => {
    const userId = uid("user-create");
    await db.users.create({
      data: { id: userId, email: `${userId}@test.io`, role: "user", status: "active", plan: "agency" },
    });
    const acc = await createEmailAccount(userId, {
      label: "Primary",
      from_name: "Sam",
      from_email: `${userId}@agency.io`,
      smtp_host: "smtp.agency.io",
      smtp_port: 587,
      smtp_username: `${userId}@agency.io`,
      smtp_password: "secret",
      imap_host: "imap.agency.io",
      imap_port: 993,
    });

    const created = await createOutreachCampaign(userId, {
      name: "Single Step Campaign",
      mode: "custom",
      senderAccountIds: [acc.id],
      recipientSource: "manual",
      subjectTemplate: "Initial",
      bodyTemplate: "Hi {{first_name}}",
      timezone: "UTC",
      recipients: [{ email: "lead@target.io", name: "Pat" }],
      steps: [{ step_no: 1, delay_days: 3, body: "Bump {{sender_first_name}}" }],
    });

    const steps = await db.campaign_steps.findMany({
      where: { campaign_id: created.campaign.id },
      orderBy: { step_no: "asc" },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].step_no).toBe(1);

    const emptySeq = await getCampaignSequence("00000000-0000-4000-8000-000000000099");
    expect(emptySeq.status).toBe("none");
    expect(emptySeq.steps).toEqual([]);
  });

  it("upserts campaign_steps by (campaign_id, step_no), preserves step 1 and referenced steps, and deletes unreferenced excess steps", async () => {
    const userId = uid("user-upsert");
    const camp = await db.outreach_campaigns.create({
      data: { id: uid("camp-upsert"), user_id: userId, name: "Upsert Camp", mode: "custom", status: "draft", timezone: "UTC" },
    });

    await saveCampaignSequence(userId, camp.id, "Seq", [
      { step_no: 1, delay_days: 2, mode: "custom", subject_template: "S1", body_template: "B1" },
      { step_no: 2, delay_days: 3, mode: "custom", subject_template: "S2", body_template: "B2" },
      { step_no: 3, delay_days: 4, mode: "custom", subject_template: "S3", body_template: "B3" },
    ]);

    // Attach a message reference to step 2 so step 2 must NOT be deleted when shrinking to 1 step
    const rec = await db.campaign_recipients.create({
      data: {
        id: uid("rec-ref"),
        user_id: userId,
        campaign_id: camp.id,
        email: "ref@target.io",
        status: "sent",
        current_step: 2,
        unsubscribe_token: uid("tok"),
      },
    });
    await db.email_messages.create({
      data: {
        user_id: userId,
        recipient_id: rec.id,
        email_account_id: uid("acc-ref"),
        direction: "out",
        kind: "followup",
        step_no: 2,
        message_id: `<msg-step2-${Date.now()}@agency.io>`,
        status: "sent",
      },
    });

    // Shrink sequence to 1 step (and also test empty save preserving step 1 & step 2)
    await saveCampaignSequence(userId, camp.id, "Seq", [
      { step_no: 1, delay_days: 5, mode: "custom", subject_template: "S1 updated", body_template: "B1 updated" },
    ]);

    const afterShrink = await db.campaign_steps.findMany({
      where: { campaign_id: camp.id },
      orderBy: { step_no: "asc" },
    });
    const stepNos = afterShrink.map((s: any) => s.step_no);
    expect(stepNos).toEqual([1, 2]); // Step 3 deleted (unreferenced), Step 2 kept (message attached)
    expect(afterShrink[0].delay_days).toBe(5);
    expect(afterShrink[0].body_template).toBe("B1 updated");

    // Empty save must still keep Step 1 and referenced Step 2
    await saveCampaignSequence(userId, camp.id, "Seq", []);
    const afterEmpty = await db.campaign_steps.findMany({
      where: { campaign_id: camp.id },
      orderBy: { step_no: "asc" },
    });
    expect(afterEmpty.map((s: any) => s.step_no)).toEqual([1, 2]);
  });

  it("never starves due follow-ups behind >20 finished recipients and enqueues via email-send queue with jitter", async () => {
    const userId = uid("user-starve");
    const acc = await createEmailAccount(userId, {
      label: "Sender",
      from_name: "Sam",
      from_email: `${userId}@agency.io`,
      smtp_host: "smtp.agency.io",
      smtp_port: 587,
      smtp_username: `${userId}@agency.io`,
      smtp_password: "secret",
      imap_host: "imap.agency.io",
      imap_port: 993,
    });
    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-starve"),
        user_id: userId,
        name: "Starvation Test",
        mode: "custom",
        status: "running",
        timezone: "UTC",
        send_window: { startHour: 0, endHour: 24 },
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await saveCampaignSequence(userId, camp.id, "Seq", [
      { step_no: 1, delay_days: 2, mode: "custom", subject_template: "Re: Hi", body_template: "Follow-up 1" },
    ]);

    // Seed 25 finished recipients (next_followup_at: null, current_step: 1) before the due recipient
    for (let i = 0; i < 25; i++) {
      await db.campaign_recipients.create({
        data: {
          id: uid(`rec-done-${i}`),
          user_id: userId,
          campaign_id: camp.id,
          assigned_account_id: acc.id,
          email: `done-${i}-${Date.now()}@target.io`,
          status: "sent",
          current_step: 1,
          replied_at: null,
          next_followup_at: null,
          unsubscribe_token: uid(`tok-done-${i}`),
        },
      });
    }

    const dueRec = await db.campaign_recipients.create({
      data: {
        id: uid("rec-due-26"),
        user_id: userId,
        campaign_id: camp.id,
        assigned_account_id: acc.id,
        email: `due-26-${Date.now()}@target.io`,
        status: "sent",
        current_step: 0,
        replied_at: null,
        next_followup_at: new Date(Date.now() - 60_000),
        unsubscribe_token: uid("tok-due"),
      },
    });

    const result = await dispatchDueFollowups(new Date());
    expect(result.scheduled).toBeGreaterThanOrEqual(1);
    expect(mockQueueEmailSend).toHaveBeenCalledWith(dueRec.id, expect.any(Number), 1, "followup");
    expect(sentMailMock).not.toHaveBeenCalled(); // Queued via BullMQ, not sent inline in cron loop
  });

  it("checks campaign_steps (not campaign_sequence_steps) in updateCampaignStatus", async () => {
    const userId = uid("user-status-guard");
    await db.users.create({
      data: { id: userId, email: `${userId}@test.io`, role: "user", status: "active", plan: "agency" },
    });
    await recordWorkspaceLegalAcknowledgement(userId);
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-oauth-only"),
        user_id: userId,
        provider: "gmail_api",
        from_email: `${userId}@gmail.com`,
        status: "active",
        oauth_scopes: ["https://www.googleapis.com/auth/gmail.send"],
        imap_host: null,
      },
    });
    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-status-guard"),
        user_id: userId,
        name: "Status Guard",
        mode: "custom",
        status: "draft",
        timezone: "UTC",
      },
    });
    await saveCampaignSequence(userId, camp.id, "Seq", [
      { step_no: 1, delay_days: 3, mode: "custom", subject_template: "Re: Hi", body_template: "Bump" },
    ]);

    // Ensure outreach_campaign_accounts returns the linked account if queried
    const origFindMany = db.outreach_campaign_accounts.findMany;
    db.outreach_campaign_accounts.findMany = async () => [{ campaign_id: camp.id, email_account: acc }];
    try {
      await expect(updateCampaignStatus(userId, camp.id, "running")).rejects.toThrow(
        /does not support reply detection/
      );
    } finally {
      db.outreach_campaign_accounts.findMany = origFindMany;
    }
  });
});
