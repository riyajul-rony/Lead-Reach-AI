import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import {
  validateVariantInputs,
  selectVariantForRecipient,
  getCampaignVariantStats,
} from "./variant-service";
import { sendSingleRecipientEmail } from "./sending-engine";
import { createOutreachCampaign } from "./campaign-service";
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
        return { messageId: `<mock-ab-${Date.now()}@company.com>`, accepted: [mailOptions.to] };
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

describe("Phase 3 Step 2: Campaign A/B Testing", () => {
  const userId = "user-ab-test-1";

  beforeEach(() => {
    sentMailMock.mockClear();
    mockSession.mockResolvedValue({ user: { id: userId, email: "ab@company.com" } });
  });

  it("rejects variant weights <= 0", () => {
    expect(() =>
      validateVariantInputs([
        { label: "A", weight: 50 },
        { label: "B", weight: 0 },
      ])
    ).toThrow(/greater than 0/);

    expect(() =>
      validateVariantInputs([{ label: "A", weight: -10 }])
    ).toThrow(/greater than 0/);
  });

  it("distributes recipients deterministically across variants, tracks per-variant metrics, and preserves variant_id on retry", async () => {
    await db.email_accounts.create({
      data: {
        id: "acc-ab-1",
        user_id: userId,
        provider: "smtp",
        label: "AB SMTP",
        from_name: "Alex",
        from_email: "ab@company.com",
        smtp_host: "smtp.company.com",
        smtp_port: 587,
        smtp_username: "ab@company.com",
        smtp_password_enc: encrypt("app-pass"),
        hourly_limit: 25,
        daily_limit: 150,
        min_gap_seconds: 1,
        max_gap_seconds: 1,
        gap_seconds: 1,
        status: "active",
      },
    });

    const recipientInputs = Array.from({ length: 12 }, (_, idx) => ({
      email: `lead_${idx}@abtarget.com`,
      name: `Lead ${idx}`,
      company: `Company ${idx}`,
    }));

    const { campaign } = await createOutreachCampaign(userId, {
      name: "AB Split Campaign",
      mode: "custom",
      senderAccountIds: ["acc-ab-1"],
      recipientSource: "manual",
      recipients: recipientInputs,
      subjectTemplate: "Subject A {{company_name}}",
      bodyTemplate: "Body A for {{first_name}}",
      variants: [
        {
          step_no: 0,
          label: "A",
          subject_template: "Subject A {{company_name}}",
          body_template: "Body A for {{first_name}}",
          weight: 50,
        },
        {
          step_no: 0,
          label: "B",
          subject_template: "Subject B {{company_name}}",
          body_template: "Body B for {{first_name}}",
          weight: 50,
        },
      ],
      timezone: "UTC",
      launchNow: false,
    });

    const createdRecipients = await db.campaign_recipients.findMany({
      where: { campaign_id: campaign.id },
    });
    expect(createdRecipients.length).toBe(12);

    let countA = 0;
    let countB = 0;
    for (const r of createdRecipients) {
      const picked1 = await selectVariantForRecipient(campaign.id, 0, r);
      const picked2 = await selectVariantForRecipient(campaign.id, 0, r);
      expect(picked1?.id).toBe(picked2?.id); // deterministic
      if (picked1?.label === "A") countA++;
      if (picked1?.label === "B") countB++;
    }
    expect(countA).toBeGreaterThan(0);
    expect(countB).toBeGreaterThan(0);

    // Send first recipient and verify variant_id is persisted & preserved across retry
    await db.outreach_campaigns.update({ where: { id: campaign.id }, data: { status: "running" } });
    const firstRec = createdRecipients[0];
    const assigned = await selectVariantForRecipient(campaign.id, 0, firstRec);
    await db.campaign_recipients.update({
      where: { id: firstRec.id },
      data: { status: "needs_review", variant_id: assigned!.id },
    });

    const retryReq = new NextRequest(`http://localhost:3000/api/v1/outreach/campaigns/${campaign.id}/retry`, {
      method: "POST",
    });
    const retryRes = await RetryRoute.POST(retryReq, { params: Promise.resolve({ id: campaign.id }) });
    expect(retryRes.status).toBe(200);

    const afterRetry = await db.campaign_recipients.findUnique({ where: { id: firstRec.id } });
    expect(afterRetry?.status).toBe("queued");
    expect(afterRetry?.variant_id).toBe(assigned!.id);

    const sendRes = await sendSingleRecipientEmail(firstRec.id);
    expect(sendRes).toHaveProperty("success", true);
    expect(sentMailMock).toHaveBeenCalledTimes(1);
    const mail = sentMailMock.mock.calls[0][0];
    expect(mail.subject).toContain(`Subject ${assigned!.label}`);

    // Log tracking events & reply and verify per-variant stats
    await db.tracking_events.create({
      data: {
        campaign_id: campaign.id,
        recipient_id: firstRec.id,
        variant_id: assigned!.id,
        event_type: "open",
      },
    });
    await db.tracking_events.create({
      data: {
        campaign_id: campaign.id,
        recipient_id: firstRec.id,
        variant_id: assigned!.id,
        event_type: "click",
        link_url: "https://example.com",
      },
    });
    await db.campaign_recipients.update({
      where: { id: firstRec.id },
      data: { status: "replied" },
    });

    const stats = await getCampaignVariantStats(campaign.id);
    const targetStat = stats.find((s) => s.id === assigned!.id);
    expect(targetStat?.sent).toBe(1);
    expect(targetStat?.opened).toBe(1);
    expect(targetStat?.clicked).toBe(1);
    expect(targetStat?.replied).toBe(1);

    // Deleting variant sets variant_id = null without breaking historical recipient record
    await db.campaign_variants.delete({ where: { id: assigned!.id } });
    const recAfterVariantDelete = await db.campaign_recipients.findUnique({ where: { id: firstRec.id } });
    expect(recAfterVariantDelete).not.toBeNull();
    expect(recAfterVariantDelete?.variant_id).toBeNull();
  });

  it("keeps single-variant campaigns 100% backwards-compatible", async () => {
    const camp = await db.outreach_campaigns.create({
      data: {
        id: "camp-legacy-single",
        user_id: userId,
        name: "Legacy Campaign",
        mode: "custom",
        status: "running",
        subject_template: "Legacy Subj",
        body_template: "Legacy Body",
        timezone: "UTC",
      },
    });

    const selected = await selectVariantForRecipient(camp.id, 0, { id: "rec-legacy-1" });
    expect(selected).toBeNull();
  });
});
