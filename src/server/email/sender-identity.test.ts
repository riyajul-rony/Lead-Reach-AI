import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { createEmailAccount } from "@/server/email/account-service";
import { createOutreachCampaign } from "@/server/email/campaign-service";
import { sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { saveCampaignSequence, sendSingleRecipientFollowup } from "@/server/email/sequence-service";
import {
  formatFromHeader,
  resolveAccountSenderName,
  resolveSenderFirstName,
} from "@/server/email/sender-identity";
import { renderEmailTemplate } from "@/server/email/template-renderer";

const { sentMailMock, mockSession, fetchMock } = vi.hoisted(() => ({
  sentMailMock: vi.fn().mockResolvedValue({ messageId: "<sender-id-1@agency.com>" }),
  mockSession: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: sentMailMock,
      close: vi.fn(),
    }),
  },
}));

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

import * as EmailAccountsRoute from "@/app/api/v1/email-accounts/route";
import * as SingleAccountRoute from "@/app/api/v1/email-accounts/[id]/route";
import * as TestSendRoute from "@/app/api/v1/outreach/test-send/route";

describe("Phase 6 Task 3: From Name (senderName) & {{sender_first_name}}", () => {
  let userId = "88888888-8888-4888-8888-888888888801";
  let idx = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    sentMailMock.mockResolvedValue({ messageId: "<sender-id-1@agency.com>" });
    idx++;
    userId = `88888888-8888-4888-8888-88888888880${idx}`;
    await db.users.create({
      data: {
        id: userId,
        email: `sender-${idx}@leadreach.io`,
        name: "Alex Carter",
        role: "user",
        status: "active",
        plan: "agency",
      },
    });
    mockSession.mockResolvedValue({
      sessionId: `sess-sender-${idx}`,
      user: {
        id: userId,
        email: `sender-${idx}@leadreach.io`,
        name: "Alex Carter",
        role: "user",
      },
    });
  });

  it("composes From headers cleanly and strips CR/LF and unsafe quotes", () => {
    expect(
      formatFromHeader({ senderName: "Alex Carter", from_email: "alex@agency.com" })
    ).toBe('"Alex Carter" <alex@agency.com>');

    expect(
      formatFromHeader({ from_name: "Sarah Connor", from_email: "sarah@agency.com" })
    ).toBe('"Sarah Connor" <sarah@agency.com>');

    expect(
      formatFromHeader({ from_name: "   ", from_email: "nobody@agency.com" })
    ).toBe("nobody@agency.com");

    expect(
      formatFromHeader({
        senderName: 'Alex "Growth"\r\nCarter',
        from_email: "alex@agency.com",
      })
    ).toBe('"Alex \'Growth\' Carter" <alex@agency.com>');
  });

  it("extracts sender_first_name and renders {{sender_first_name}} with fallback", () => {
    expect(resolveSenderFirstName({ senderName: "Alex Carter" })).toBe("Alex");
    expect(resolveSenderFirstName({ from_name: "  Maya  " })).toBe("Maya");
    expect(resolveSenderFirstName({ from_name: "" })).toBe("");
    expect(resolveAccountSenderName({ from_name: "Jordan Lee" })).toBe("Jordan Lee");

    const rendered = renderEmailTemplate("Best,\n{{sender_first_name}}", {
      sender_first_name: resolveSenderFirstName({ senderName: "Alex Carter" }),
    });
    expect(rendered).toBe("Best,\nAlex");

    const withFallback = renderEmailTemplate("Best,\n{{sender_first_name|Your Team}}", {
      sender_first_name: resolveSenderFirstName({ senderName: "" }),
    });
    expect(withFallback).toBe("Best,\nYour Team");
  });

  it("uses editable senderName in From header and renders {{sender_first_name}} in initial, follow-up, Gmail API, and test-send", async () => {
    const account = await createEmailAccount(userId, {
      label: "Alex Outreach",
      senderName: "Alex Carter",
      from_email: `alex-${idx}@agency.com`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: `alex-${idx}@agency.com`,
      smtp_password: "app-password",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });

    const camp = await createOutreachCampaign(userId, {
      name: "Sender Identity Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Hi {{first_name}} from {{sender_first_name}}",
      bodyTemplate: "Hi {{first_name}},\n\nCheers,\n{{sender_first_name}}",
      timezone: "UTC",
      recipients: [{ email: "prospect@company.com", name: "Taylor Brooks" }],
    });

    await saveCampaignSequence(userId, camp.campaign.id, "Seq", [
      {
        step_no: 1,
        delay_days: 1,
        mode: "custom",
        subject_template: "Re: Hi {{first_name}} from {{sender_first_name}}",
        body_template: "Quick follow-up,\n{{sender_first_name}}",
      },
    ]);

    await db.outreach_campaigns.update({
      where: { id: camp.campaign.id },
      data: { status: "running" },
    });
    const rec = await db.campaign_recipients.findFirst({ where: { campaign_id: camp.campaign.id } });

    await sendSingleRecipientEmail(rec.id);
    expect(sentMailMock).toHaveBeenCalledTimes(1);
    const mail0 = sentMailMock.mock.calls[0][0];
    expect(mail0.from).toBe(`"Alex Carter" <alex-${idx}@agency.com>`);
    expect(mail0.subject).toBe("Hi Taylor from Alex");
    expect(mail0.text).toBe("Hi Taylor,\n\nCheers,\nAlex");

    // PATCH senderName via API and verify follow-up reflects the updated From name & {{sender_first_name}}
    const patchReq = new NextRequest(`http://localhost:3000/api/v1/email-accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({ senderName: "Morgan Reed" }),
    });
    const patchRes = await SingleAccountRoute.PATCH(patchReq, {
      params: Promise.resolve({ id: account.id }),
    });
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.data.senderName).toBe("Morgan Reed");

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
    const mail1 = sentMailMock.mock.calls[1][0];
    expect(mail1.from).toBe(`"Morgan Reed" <alex-${idx}@agency.com>`);
    expect(mail1.text).toBe("Quick follow-up,\nMorgan");

    // Verify test-send renders {{sender_first_name}} cleanly too
    const testReq = new NextRequest("http://localhost:3000/api/v1/outreach/test-send", {
      method: "POST",
      body: JSON.stringify({
        accountId: account.id,
        toEmail: "qa@company.com",
        subject: "Test from {{sender_first_name}}",
        body: "Signed, {{sender_first_name}}",
      }),
    });
    const testRes = await TestSendRoute.POST(testReq);
    const testJson = await testRes.json();
    expect(testRes.status).toBe(200);
    expect(testJson.renderedSubject).toBe("Test from Morgan");
    expect(testJson.renderedBody).toBe("Signed, Morgan");
  });

  it("defaults senderName from user profile on POST and formats Gmail API RFC-2822 From header", async () => {
    const createReq = new NextRequest("http://localhost:3000/api/v1/email-accounts", {
      method: "POST",
      body: JSON.stringify({
        from_email: `defaulted-${idx}@gmail.com`,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_password: "abcdefghijklmnop",
      }),
    });
    const createRes = await EmailAccountsRoute.POST(createReq);
    const createJson = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(createJson.data.senderName).toBe("Alex Carter");
    expect(createJson.data.from_name).toBe("Alex Carter");

    // Verify Gmail API From header formatting
    const prevFetch = global.fetch;
    global.fetch = fetchMock as any;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "gmail-from-1" }) });
    try {
      const gmailAcc = await db.email_accounts.create({
        data: {
          user_id: userId,
          provider: "gmail_api",
          label: "Gmail Sender",
          from_name: "Priya Nair",
          from_email: `priya-${idx}@gmail.com`,
          oauth_access_token_enc: encrypt("tok"),
          oauth_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          status: "active",
        },
      });
      const camp = await createOutreachCampaign(userId, {
        name: "Gmail From Test",
        mode: "custom",
        senderAccountIds: [gmailAcc.id],
        recipientSource: "manual",
        subjectTemplate: "Hello",
        bodyTemplate: "Hi,\n\n{{sender_first_name}}",
        timezone: "UTC",
        recipients: [{ email: "lead@company.com", name: "Dana" }],
      });
      await db.outreach_campaigns.update({
        where: { id: camp.campaign.id },
        data: { status: "running" },
      });
      const rec = await db.campaign_recipients.findFirst({ where: { campaign_id: camp.campaign.id } });
      await sendSingleRecipientEmail(rec.id);

      const reqInit = fetchMock.mock.calls[0][1];
      const raw = Buffer.from(
        JSON.parse(reqInit.body).raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8");
      expect(raw).toContain(`From: "Priya Nair" <priya-${idx}@gmail.com>`);
    } finally {
      global.fetch = prevFetch;
    }
  });
});
