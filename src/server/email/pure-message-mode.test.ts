import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { createEmailAccount } from "@/server/email/account-service";
import { createOutreachCampaign } from "@/server/email/campaign-service";
import { sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { saveCampaignSequence, sendSingleRecipientFollowup } from "@/server/email/sequence-service";
import { updateWorkspaceBusinessAddress } from "@/server/workspace/settings";

const { sentMailMock, mockSession, fetchMock } = vi.hoisted(() => ({
  sentMailMock: vi.fn().mockResolvedValue({ messageId: "<pure-msg-123@agency.com>" }),
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

import * as TestSendRoute from "@/app/api/v1/outreach/test-send/route";

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "generated") {
        continue;
      }
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("Phase 6 Task 1: Pure Message Mode (no body injection)", () => {
  let userId = "66666666-6666-4666-8666-666666666601";
  let testIdx = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    sentMailMock.mockResolvedValue({ messageId: "<pure-msg-123@agency.com>" });
    testIdx++;
    userId = `66666666-6666-4666-8666-66666666660${testIdx}`;
    await db.users.create({
      data: {
        id: userId,
        email: `puremode-${testIdx}@leadreach.io`,
        name: "Alex Carter",
        role: "user",
        status: "active",
        plan: "agency",
      },
    });
    mockSession.mockResolvedValue({
      sessionId: `sess-pure-${testIdx}`,
      user: {
        id: userId,
        email: `puremode-${testIdx}@leadreach.io`,
        name: "Alex Carter",
        role: "user",
      },
    });
  });

  it("sends Step 1 plain-text email verbatim with text/plain only and List-Unsubscribe headers intact", async () => {
    await updateWorkspaceBusinessAddress(userId, "500 Market St, San Francisco, CA");

    const account = await createEmailAccount(userId, {
      label: "Alex Inbox",
      from_name: "Alex Carter",
      from_email: "alex@agency.com",
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: "alex@agency.com",
      smtp_password: "app-password",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });

    const camp = await createOutreachCampaign(userId, {
      name: "Pure Mode Step 1 Campaign",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Quick note for {{company_name}}",
      bodyTemplate: "Hi {{first_name}},\n\nSaw your site and wanted to say hello.\n\nBest,\nAlex",
      timezone: "UTC",
      recipients: [{ email: "lead1@example.com", name: "Dana White", company: "Dana Dental" }],
    });

    await db.outreach_campaigns.update({
      where: { id: camp.campaign.id },
      data: { status: "running" },
    });

    const recipient = await db.campaign_recipients.findFirst({
      where: { campaign_id: camp.campaign.id },
    });

    const result = await sendSingleRecipientEmail(recipient.id);
    expect(result).toHaveProperty("success", true);
    expect(sentMailMock).toHaveBeenCalledTimes(1);

    const mail = sentMailMock.mock.calls[0][0];
    // Body equals rendered template verbatim (no footer, no "---", no address, no unsubscribe line)
    expect(normalizeLineEndings(mail.text)).toBe(
      "Hi Dana,\n\nSaw your site and wanted to say hello.\n\nBest,\nAlex"
    );
    expect(mail.text).not.toContain("---");
    expect(mail.text).not.toContain("500 Market St");
    expect(mail.text).not.toContain("To unsubscribe");
    // Plain-text template with tracking off omits HTML completely
    expect(mail.html).toBeUndefined();
    // Compliance headers remain intact
    expect(mail.headers["List-Unsubscribe"]).toBe(
      `<http://localhost:3000/u/${recipient.unsubscribe_token}>`
    );
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("dispatches pure text/plain RFC-2822 message (no HTML MIME part) via Gmail API", async () => {
    const prevFetch = global.fetch;
    global.fetch = fetchMock as any;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "gmail-msg-1" }),
    });

    try {
      const gmailAcc = await db.email_accounts.create({
        data: {
          user_id: userId,
          provider: "gmail_api",
          label: "Pure Gmail",
          from_name: "Alex Carter",
          from_email: "alex@gmail.com",
          oauth_access_token_enc: encrypt("mock_access_token"),
          oauth_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          status: "active",
        },
      });

      const camp = await createOutreachCampaign(userId, {
        name: "Pure Gmail RFC2822",
        mode: "custom",
        senderAccountIds: [gmailAcc.id],
        recipientSource: "manual",
        subjectTemplate: "Hello {{first_name}}",
        bodyTemplate: "Hi {{first_name}},\n\nPure plain text check.\n\nAlex",
        timezone: "UTC",
        recipients: [{ email: "target@company.com", name: "Sam Lee", company: "Lee Labs" }],
      });

      await db.outreach_campaigns.update({
        where: { id: camp.campaign.id },
        data: { status: "running" },
      });

      const recipient = await db.campaign_recipients.findFirst({
        where: { campaign_id: camp.campaign.id },
      });

      const result = await sendSingleRecipientEmail(recipient.id);
      expect(result).toHaveProperty("success", true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const reqInit = fetchMock.mock.calls[0][1];
      const payload = JSON.parse(reqInit.body);
      const rawRfc2822 = Buffer.from(
        payload.raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8");

      expect(rawRfc2822).toContain("Content-Type: text/plain; charset=utf-8");
      expect(rawRfc2822).not.toContain("multipart/alternative");
      expect(rawRfc2822).not.toContain("text/html");
      expect(rawRfc2822).toContain(`List-Unsubscribe: <http://localhost:3000/u/${recipient.unsubscribe_token}>`);
      expect(rawRfc2822).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("sends follow-up step verbatim and renders {{business_address}} and {{unsubscribe_url}} only when placed in template", async () => {
    await updateWorkspaceBusinessAddress(userId, "77 Battery St, Boston, MA");

    const account = await createEmailAccount(userId, {
      label: "Followup Inbox",
      from_name: "Alex Carter",
      from_email: "alex-fu@agency.com",
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: "alex-fu@agency.com",
      smtp_password: "app-password",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });

    const camp = await createOutreachCampaign(userId, {
      name: "Followup Pure Mode",
      mode: "custom",
      senderAccountIds: [account.id],
      recipientSource: "manual",
      subjectTemplate: "Initial Subject",
      bodyTemplate: "Hi {{first_name}}, pure body only.",
      timezone: "UTC",
      recipients: [{ email: "fu-lead@example.com", name: "Mia Chen", company: "Chen Ops" }],
    });

    await saveCampaignSequence(userId, camp.campaign.id, "Seq", [
      {
        step_no: 1,
        delay_days: 0,
        mode: "custom",
        subject_template: "Re: Initial Subject",
        body_template:
          "Hi {{first_name}},\n\nChecking back.\n\n{{business_address}}\nOpt out: {{unsubscribe_url}}",
      },
    ]);

    await db.outreach_campaigns.update({
      where: { id: camp.campaign.id },
      data: { status: "running" },
    });

    const recipient = await db.campaign_recipients.findFirst({
      where: { campaign_id: camp.campaign.id },
    });
    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: {
        status: "sent",
        current_step: 0,
        sent_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        last_sent_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        next_followup_at: new Date(Date.now() - 1000).toISOString(),
        thread_message_id: "<orig-thread@agency.com>",
      },
    });

    const fuRes = await sendSingleRecipientFollowup(recipient.id);
    expect(fuRes).toHaveProperty("success", true);
    expect(sentMailMock).toHaveBeenCalledTimes(1);

    const mail = sentMailMock.mock.calls[0][0];
    const expectedUnsubUrl = `http://localhost:3000/u/${recipient.unsubscribe_token}`;
    expect(normalizeLineEndings(mail.text)).toBe(
      `Hi Mia,\n\nChecking back.\n\n77 Battery St, Boston, MA\nOpt out: ${expectedUnsubUrl}`
    );
    expect(mail.html).toBeUndefined();
    expect(mail.headers["List-Unsubscribe"]).toBe(`<${expectedUnsubUrl}>`);
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("test-send renders exact message with no [TEST PREVIEW] prefix or footer", async () => {
    await updateWorkspaceBusinessAddress(userId, "99 Howard St, Austin, TX");

    const gmailAcc = await db.email_accounts.create({
      data: {
        user_id: userId,
        provider: "gmail_api",
        label: "Test Send Gmail",
        from_name: "Alex Carter",
        from_email: "alex@company.com",
        oauth_access_token_enc: encrypt("tok"),
        status: "active",
      },
    });

    const req = new NextRequest("http://localhost:3000/api/v1/outreach/test-send", {
      method: "POST",
      body: JSON.stringify({
        accountId: gmailAcc.id,
        toEmail: "qa@company.com",
        subject: "Quick idea for {{company_name}}",
        body: "Hi {{first_name}},\n\nExact test message.",
        sampleData: {
          first_name: "Jordan",
          company_name: "Northwind",
        },
      }),
    });

    const res = await TestSendRoute.POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.renderedSubject).toBe("Quick idea for Northwind");
    expect(json.renderedSubject).not.toContain("[TEST PREVIEW]");
    expect(json.renderedBody).toBe("Hi Jordan,\n\nExact test message.");
    expect(json.renderedBody).not.toContain("[Test Preview sent");
    expect(json.renderedBody).not.toContain("99 Howard St");
  });

  it("does not contain the hardcoded placeholder postal address anywhere in src/", () => {
    const srcRoot = path.resolve(process.cwd(), "src");
    const files = collectSourceFiles(srcRoot);
    const forbiddenAddress = ["123 Innovation", "Way"].join(" ");
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes(forbiddenAddress)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
