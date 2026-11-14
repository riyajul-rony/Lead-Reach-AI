import { describe, it, expect, beforeEach } from "vitest";
import { accountHasWorkingReplyDetection } from "@/server/email/account-service";
import { sendSingleRecipientFollowup } from "@/server/email/sequence-service";
import { createOutreachCampaign } from "@/server/email/campaign-service";
import { isAutoReplyMessage, isBounceMessage } from "@/server/worker/reply-poller";
import { db } from "@/server/db";

describe("CRIT-03: Reply Detection & Threading Guarantees", () => {
  describe("1. accountHasWorkingReplyDetection guard", () => {
    it("rejects Gmail OAuth accounts with default scopes (gmail.send only)", () => {
      const account = {
        provider: "gmail_api",
        oauth_scopes: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        imap_host: null,
        imap_password_enc: null,
      };

      const result = accountHasWorkingReplyDetection(account);
      expect(result.capable).toBe(false);
      expect(result.reason).toContain("For follow-ups and stop-on-reply, connect with App Password + IMAP");
    });

    it("accepts Gmail OAuth accounts if gmail.readonly is explicitly granted", () => {
      const account = {
        provider: "gmail_api",
        oauth_scopes: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
      };

      const result = accountHasWorkingReplyDetection(account);
      expect(result.capable).toBe(true);
    });

    it("accepts accounts configured with App Password + IMAP host & password", () => {
      const account = {
        provider: "smtp",
        imap_host: "imap.gmail.com",
        imap_password_enc: "encrypted_app_pass",
      };

      const result = accountHasWorkingReplyDetection(account);
      expect(result.capable).toBe(true);
    });

    it("accepts accounts that delegate to a designated reply inbox", () => {
      const account = {
        provider: "gmail_api",
        oauth_scopes: ["https://www.googleapis.com/auth/gmail.send"],
        reply_inbox_account_id: "linked-inbox-uuid",
      };

      const result = accountHasWorkingReplyDetection(account);
      expect(result.capable).toBe(true);
    });

    it("rejects accounts whose status is needs_attention (e.g. failing IMAP credentials)", () => {
      const account = {
        provider: "smtp",
        imap_host: "imap.gmail.com",
        imap_password_enc: "encrypted_app_pass",
        status: "needs_attention",
      };

      const result = accountHasWorkingReplyDetection(account);
      expect(result.capable).toBe(false);
      expect(result.reason).toContain("needs_attention");
    });
  });

  describe("2. Pre-dispatch Follow-up Guard in sequence-service", () => {
    it("skips follow-up dispatch if sender account lacks working reply detection", async () => {
      const mockUser = {
        id: "user-crit03-test",
        email: "test@leadreach.ai",
        name: "Test User",
      };

      const senderAccount = await db.email_accounts.create({
        data: {
          id: "acc-oauth-only",
          user_id: mockUser.id,
          provider: "gmail_api",
          from_email: "sender@gmail.com",
          from_name: "OAuth Sender",
          status: "active",
          oauth_scopes: ["https://www.googleapis.com/auth/gmail.send"],
          imap_host: null,
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          id: "camp-crit03-guard",
          user_id: mockUser.id,
          name: "Guard Test Campaign",
          status: "running",
          recipient_source: "manual",
          timezone: "UTC",
        },
      });

      await db.followup_sequences.create({
        data: {
          id: "seq-crit03-guard",
          campaign_id: campaign.id,
          user_id: mockUser.id,
          status: "active",
          steps: [
            {
              step_no: 2,
              delay_days: 1,
              subject: "Followup on previous note",
              body: "Checking in to see if you had time to review.",
              same_thread: true,
            },
          ],
        },
      });

      const recipient = await db.campaign_recipients.create({
        data: {
          id: "rec-crit03-guard",
          campaign_id: campaign.id,
          user_id: mockUser.id,
          email: "lead@target.com",
          first_name: "Target",
          company_name: "Target Inc",
          status: "sent",
          current_step: 1,
          last_sent_at: new Date(Date.now() - 2 * 86400000), // sent 2 days ago
          assigned_account_id: senderAccount.id,
          unsubscribe_token: "tok_guard_1234567890123456789012",
        },
      });

      const dispatchResult = await sendSingleRecipientFollowup(recipient.id);

      expect(dispatchResult.skipped).toBe(true);
      expect(dispatchResult.reason).toContain("does not support reply detection");
    });
  });

  describe("3. Campaign Launch Guard in campaign-service", () => {
    it("blocks launching a campaign with follow-up steps when sender account lacks reply detection", async () => {
      const testUserId = "user-crit03-launch-guard";
      await db.users.create({
        data: {
          id: testUserId,
          email: "launch_guard@test.com",
          name: "Launch Guard User",
          role: "user",
        },
      });

      const senderAcc = await db.email_accounts.create({
        data: {
          id: "acc-launch-oauth-only",
          user_id: testUserId,
          provider: "gmail_api",
          from_email: "launch_oauth@gmail.com",
          status: "active",
          oauth_scopes: ["https://www.googleapis.com/auth/gmail.send"],
          imap_host: null,
        },
      });

      await expect(
        createOutreachCampaign(testUserId, {
          name: "Campaign with Followups on OAuth Only",
          mode: "custom",
          senderAccountIds: [senderAcc.id],
          recipientSource: "manual",
          subjectTemplate: "Initial outreach",
          bodyTemplate: "Hello {{first_name}}",
          timezone: "UTC",
          launchNow: true,
          steps: [
            {
              step_no: 1,
              delay_days: 3,
              subject: "Follow up",
              body: "Following up",
            },
          ],
          recipients: [{ email: "client@target.com", name: "Client" }],
        })
      ).rejects.toThrow(/does not support reply detection/);
    });
  });

  describe("4. Bounce and Auto-Reply Detection Utilities", () => {
    it("correctly identifies Out of Office auto-replies", () => {
      expect(isAutoReplyMessage("Automatic reply: Away on vacation", "")).toBe(true);
      expect(isAutoReplyMessage("Out of office: Back Monday", "")).toBe(true);
      expect(isAutoReplyMessage("", "I am currently out of office with no email access.")).toBe(true);
      expect(isAutoReplyMessage("Quick question about the proposal", "Thanks for reaching out! Let's talk.")).toBe(false);
    });

    it("correctly identifies bounce/undeliverable messages", () => {
      expect(isBounceMessage("mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)")).toBe(true);
      expect(isBounceMessage("postmaster@target.com", "Undeliverable: Question regarding your clinic")).toBe(true);
      expect(isBounceMessage("lead@target.com", "Re: Question regarding your clinic")).toBe(false);
    });
  });
});
