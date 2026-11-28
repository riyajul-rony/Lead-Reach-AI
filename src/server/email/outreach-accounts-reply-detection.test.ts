import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import {
  accountHasWorkingReplyDetection,
  createEmailAccount,
  listEmailAccounts,
} from "@/server/email/account-service";
import { createOutreachCampaign } from "@/server/email/campaign-service";
import { listUserWarmupLogs } from "@/server/email/warmup-pool-service";
import { recordWorkspaceLegalAcknowledgement } from "@/server/legal/acknowledgement";
import { startFreeTrialForUser } from "@/server/billing/trial";
import * as AccountsRoute from "@/app/api/v1/email-accounts/route";
import * as AccountByIdRoute from "@/app/api/v1/email-accounts/[id]/route";

const { mockSession } = vi.hoisted(() => ({
  mockSession: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

describe("Email Accounts Reply Detection Readiness (API + Launch Guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks newly connected SMTP+IMAP accounts as reply-detection ready without exposing encrypted secrets and allows follow-up campaigns", async () => {
    const userId = `u-imap-ready-${Date.now()}`;
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        name: "Inbox Owner",
        role: "user",
      },
    });
    await startFreeTrialForUser(userId, { trialDays: 14 });
    mockSession.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
    await recordWorkspaceLegalAcknowledgement(userId);

    const acc1 = await createEmailAccount(userId, {
      label: "Inbox 1",
      from_name: "Alice Sender",
      from_email: `alice-${Date.now()}@gmail.com`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_security: "starttls",
      smtp_username: "alice@gmail.com",
      smtp_password: "abcdefghijklmnop",
      imap_host: "imap.gmail.com",
      imap_port: 993,
      imap_security: "ssl",
      warmup_enabled: true,
    });

    const acc2 = await createEmailAccount(userId, {
      label: "Inbox 2",
      from_name: "Bob Sender",
      from_email: `bob-${Date.now()}@gmail.com`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_security: "starttls",
      smtp_username: "bob@gmail.com",
      smtp_password: "ponmlkjihgfedcba",
      imap_host: "imap.gmail.com",
      imap_port: 993,
      imap_security: "ssl",
      warmup_enabled: true,
    });

    // Newly connected accounts have not been polled yet (last_polled_at is null)
    const listed = await listEmailAccounts(userId);
    expect(listed).toHaveLength(2);
    for (const acc of listed) {
      expect(acc.has_imap_password).toBe(true);
      expect(acc.has_reply_detection).toBe(true);
      expect(acc.reply_detection_reason).toBeUndefined();
      expect((acc as any).imap_password_enc).toBeUndefined();
      expect((acc as any).smtp_password_enc).toBeUndefined();
    }

    // GET /api/v1/email-accounts exposes safe booleans and never encrypted passwords
    const listRes = await AccountsRoute.GET();
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data).toHaveLength(2);
    for (const item of listJson.data) {
      expect(item.has_imap_password).toBe(true);
      expect(item.has_reply_detection).toBe(true);
      expect(item.imap_password_enc).toBeUndefined();
      expect(item.smtp_password_enc).toBeUndefined();
    }

    // GET /api/v1/email-accounts/[id] also returns has_reply_detection safely
    const singleRes = await AccountByIdRoute.GET(
      new NextRequest(`http://localhost:3000/api/v1/email-accounts/${acc1.id}`),
      { params: Promise.resolve({ id: acc1.id }) }
    );
    expect(singleRes.status).toBe(200);
    const singleJson = await singleRes.json();
    expect(singleJson.data.has_imap_password).toBe(true);
    expect(singleJson.data.has_reply_detection).toBe(true);
    expect(singleJson.data.imap_password_enc).toBeUndefined();

    // Warmup pool summary and listed accounts must agree on IMAP & reply detection readiness
    const warmup = await listUserWarmupLogs(userId, { limit: 10 });
    expect(warmup.summary.poolCount).toBe(2);
    expect(warmup.summary.imapCapableCount).toBe(2);

    // Follow-up campaign launches without being blocked
    const createdCampaign = await createOutreachCampaign(userId, {
      name: "Follow-up Ready Campaign",
      mode: "custom",
      senderAccountIds: [acc1.id, acc2.id],
      recipientSource: "manual",
      subjectTemplate: "Quick question",
      bodyTemplate: "Hi {{first_name}}",
      timezone: "UTC",
      launchNow: true,
      steps: [
        {
          step_no: 1,
          delay_days: 2,
          subject: "Following up",
          body: "Bumping this to the top of your inbox.",
        },
      ],
      recipients: [{ email: "prospect@company.com", name: "Prospect" }],
    });
    expect(createdCampaign.campaign.status).toBe("running");
  });

  it("reports reply detection off for OAuth send-only accounts and accounts with IMAP auth/polling errors", async () => {
    const userId = `u-imap-err-${Date.now()}`;
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        name: "Error User",
        role: "user",
      },
    });
    mockSession.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
    await recordWorkspaceLegalAcknowledgement(userId);

    const oauthOnly = await db.email_accounts.create({
      data: {
        user_id: userId,
        provider: "gmail_api",
        label: "OAuth Send-Only",
        from_email: `oauth-${Date.now()}@gmail.com`,
        status: "active",
        oauth_scopes: ["https://www.googleapis.com/auth/gmail.send"],
        imap_host: null,
      },
    });

    const imapErrorAccount = await db.email_accounts.create({
      data: {
        user_id: userId,
        provider: "smtp",
        label: "Broken IMAP",
        from_email: `broken-${Date.now()}@gmail.com`,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_password_enc: "encrypted-pass",
        status: "active",
        last_error: "IMAP authorization failed: Invalid credentials",
      },
    });

    expect(accountHasWorkingReplyDetection(imapErrorAccount)).toEqual({
      capable: false,
      reason: "IMAP authorization failed: Invalid credentials",
    });

    const listRes = await AccountsRoute.GET();
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();

    const oauthView = listJson.data.find((a: any) => a.id === oauthOnly.id);
    expect(oauthView.has_reply_detection).toBe(false);
    expect(oauthView.reply_detection_reason).toContain(
      "For follow-ups and stop-on-reply, connect with App Password + IMAP"
    );

    const brokenView = listJson.data.find((a: any) => a.id === imapErrorAccount.id);
    expect(brokenView.has_reply_detection).toBe(false);
    expect(brokenView.reply_detection_reason).toContain("IMAP authorization failed");

    await expect(
      createOutreachCampaign(userId, {
        name: "Blocked IMAP Error Campaign",
        mode: "custom",
        senderAccountIds: [imapErrorAccount.id],
        recipientSource: "manual",
        subjectTemplate: "Hello",
        bodyTemplate: "Hi {{first_name}}",
        timezone: "UTC",
        launchNow: true,
        steps: [
          {
            step_no: 1,
            delay_days: 2,
            subject: "Follow up",
            body: "Checking in",
          },
        ],
        recipients: [{ email: "lead@company.com", name: "Lead" }],
      })
    ).rejects.toThrow(/does not support reply detection/);
  });
});
