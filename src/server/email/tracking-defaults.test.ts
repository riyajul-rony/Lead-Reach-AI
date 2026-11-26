import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/server/db";
import { createEmailAccount } from "@/server/email/account-service";
import { createOutreachCampaign } from "@/server/email/campaign-service";
import { sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { getCampaignSequence, sendSingleRecipientFollowup } from "@/server/email/sequence-service";

const { sentMailMock } = vi.hoisted(() => ({
  sentMailMock: vi.fn().mockResolvedValue({ messageId: "<track-test-123@agency.com>" }),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: sentMailMock,
      close: vi.fn(),
    }),
  },
}));

describe("Phase 6 Task 2: Tracking Defaults Off & Per-Step Toggles", () => {
  let userId = "77777777-7777-4777-8777-777777777701";
  let idx = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    sentMailMock.mockResolvedValue({ messageId: "<track-test-123@agency.com>" });
    idx++;
    userId = `77777777-7777-4777-8777-77777777770${idx}`;
    await db.users.create({
      data: {
        id: userId,
        email: `tracking-${idx}@leadreach.io`,
        role: "user",
        status: "active",
        plan: "agency",
      },
    });
  });

  async function setupAccount() {
    return createEmailAccount(userId, {
      label: "Sender",
      from_name: "Alex",
      from_email: `alex-${idx}@agency.com`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: `alex-${idx}@agency.com`,
      smtp_password: "app-password",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });
  }

  it("defaults tracking_open and tracking_click to false on new campaigns, steps, and sequence blueprints", async () => {
    const account = await setupAccount();
    const res = await createOutreachCampaign(userId, {
      name: "Default Tracking Off Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Hello",
      bodyTemplate: "Check https://example.com",
      timezone: "UTC",
      recipients: [{ email: "lead@target.com", name: "Sam" }],
      steps: [{ step_no: 1, delay_days: 3, body: "Bump https://example.com" }],
    });

    expect(res.campaign.tracking_open).toBe(false);
    expect(res.campaign.tracking_click).toBe(false);

    const step = await db.campaign_steps.findFirst({
      where: { campaign_id: res.campaign.id, step_no: 1 },
    });
    expect(step?.tracking_open).toBe(false);
    expect(step?.tracking_click).toBe(false);

    const savedSeq = await getCampaignSequence(res.campaign.id);
    expect(savedSeq.steps[0].tracking_open).toBe(false);
    expect(savedSeq.steps[0].tracking_click).toBe(false);

    const defaultSeq = await getCampaignSequence("non-existent-campaign");
    for (const s of defaultSeq.steps) {
      expect(s.tracking_open).toBe(false);
      expect(s.tracking_click).toBe(false);
    }
  });

  it("emits no pixel and no link rewriting when both toggles are off, preserving List-Unsubscribe", async () => {
    const account = await setupAccount();
    const res = await createOutreachCampaign(userId, {
      name: "No Tracking Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Question",
      bodyTemplate: "Hi {{first_name}}, see https://example.com/offer",
      timezone: "UTC",
      recipients: [{ email: "lead-off@target.com", name: "Dana" }],
    });

    await db.outreach_campaigns.update({
      where: { id: res.campaign.id },
      data: { status: "running" },
    });
    const rec = await db.campaign_recipients.findFirst({ where: { campaign_id: res.campaign.id } });

    const sent = await sendSingleRecipientEmail(rec.id);
    expect(sent).toHaveProperty("success", true);

    const mail = sentMailMock.mock.calls[0][0];
    expect(mail.html).toBeUndefined();
    expect(mail.text).toBe("Hi Dana, see https://example.com/offer");
    expect(mail.text).not.toContain("/api/v1/track/");
    expect(mail.headers["List-Unsubscribe"]).toBe(`<http://localhost:3000/u/${rec.unsubscribe_token}>`);
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("adds open pixel only when trackingOpen=true and omits click rewriting when trackingClick=false", async () => {
    const account = await setupAccount();
    const res = await createOutreachCampaign(userId, {
      name: "Open Only Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Open Only",
      bodyTemplate: "Hi {{first_name}}, visit https://example.com/info",
      trackingOpen: true,
      trackingClick: false,
      timezone: "UTC",
      recipients: [{ email: "open@target.com", name: "Lee" }],
    });

    await db.outreach_campaigns.update({
      where: { id: res.campaign.id },
      data: { status: "running" },
    });
    const rec = await db.campaign_recipients.findFirst({ where: { campaign_id: res.campaign.id } });

    await sendSingleRecipientEmail(rec.id);
    const mail = sentMailMock.mock.calls[0][0];

    expect(mail.html).toContain(`/api/v1/track/open/${rec.unsubscribe_token}`);
    expect(mail.html).not.toContain("/api/v1/track/click/");
    expect(mail.html).toContain('href="https://example.com/info"');
  });

  it("rewrites links only when trackingClick=true, omits pixel when trackingOpen=false, and obeys per-step follow-up flags", async () => {
    const account = await setupAccount();
    const res = await createOutreachCampaign(userId, {
      name: "Step Override Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Hello",
      bodyTemplate: "Step 0 plain link https://example.com/zero",
      trackingOpen: false,
      trackingClick: false,
      timezone: "UTC",
      recipients: [{ email: "step@target.com", name: "Mia" }],
      steps: [
        {
          step_no: 1,
          delay_days: 1,
          body: "Step 1 tracked link https://example.com/one and {{unsubscribe_url}}",
          trackingOpen: false,
          trackingClick: true,
        },
      ],
    });

    await db.outreach_campaigns.update({
      where: { id: res.campaign.id },
      data: { status: "running" },
    });
    const rec = await db.campaign_recipients.findFirst({ where: { campaign_id: res.campaign.id } });

    // Step 0: both off -> text/plain only
    await sendSingleRecipientEmail(rec.id);
    const mail0 = sentMailMock.mock.calls[0][0];
    expect(mail0.html).toBeUndefined();

    // Advance to due follow-up Step 1: trackingClick=true, trackingOpen=false
    await db.campaign_recipients.update({
      where: { id: rec.id },
      data: {
        status: "sent",
        current_step: 0,
        sent_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        last_sent_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        next_followup_at: new Date(Date.now() - 1000).toISOString(),
        thread_message_id: "<orig-0@agency.com>",
      },
    });

    await db.email_accounts.update({
      where: { id: account.id },
      data: { next_allowed_at: new Date(Date.now() - 1000).toISOString() },
    });

    const fuRes = await sendSingleRecipientFollowup(rec.id);
    expect(fuRes).toHaveProperty("success", true);
    expect(sentMailMock).toHaveBeenCalledTimes(2);

    const mail1 = sentMailMock.mock.calls[1][0];
    expect(mail1.html).toBeDefined();
    expect(mail1.html).not.toContain("/api/v1/track/open/");
    expect(mail1.html).toContain("/api/v1/track/click/");
    // /u/<token> unsubscribe link is never wrapped
    expect(mail1.html).toContain(`href="http://localhost:3000/u/${rec.unsubscribe_token}"`);
  });
});
