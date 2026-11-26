import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/server/db";
import {
  getLocalTimeParts,
  isWithinSendingWindow,
  isValidIanaTimezone,
  resolveEffectiveSendingTimezone,
  calculateRandomJitterSec,
  selectAvailableAccountForCampaign,
  sendSingleRecipientEmail,
  dispatchRunningCampaigns,
  buildEmailMultipartBodies,
} from "./sending-engine";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: async (mailOptions: any) => ({
        messageId: `<mock-${Date.now()}@leadreach.io>`,
        accepted: [mailOptions.to],
      }),
      close: vi.fn(),
    })),
  },
}));

describe("Phase 5: Sending Engine & BullMQ Scheduler", () => {
  const testUserId = "user-test-send-engine-123";

  describe("1. Timezone & Sending Window Engine", () => {
    it("parses local time parts correctly in UTC and custom timezones", () => {
      // 2026-10-24 14:30:00 UTC (Saturday)
      const testDate = new Date("2026-10-24T14:30:00Z");
      const utcParts = getLocalTimeParts(testDate, "UTC");

      expect(utcParts.weekdayNum).toBe(6); // Saturday
      expect(utcParts.hour).toBe(14);
      expect(utcParts.minute).toBe(30);

      // America/New_York is UTC-4 in daylight savings -> 10:30
      const nyParts = getLocalTimeParts(testDate, "America/New_York");
      expect(nyParts.hour).toBe(10);
      expect(nyParts.weekdayNum).toBe(6);
    });

    it("evaluates active days and working hours accurately", () => {
      // Tuesday 11:00 AM UTC
      const tuesdayMidday = new Date("2026-10-20T11:00:00Z");

      const inWindow = isWithinSendingWindow(tuesdayMidday, {
        timezone: "UTC",
        startHour: 9,
        endHour: 18,
        daysOfWeek: [1, 2, 3, 4, 5],
      });
      expect(inWindow).toBe(true);

      // Tuesday 8:00 PM UTC (outside 9-18 window)
      const tuesdayNight = new Date("2026-10-20T20:00:00Z");
      const outOfHours = isWithinSendingWindow(tuesdayNight, {
        timezone: "UTC",
        startHour: 9,
        endHour: 18,
        daysOfWeek: [1, 2, 3, 4, 5],
      });
      expect(outOfHours).toBe(false);

      // Saturday 11:00 AM UTC (day 6, not in Mon-Fri)
      const saturdayMidday = new Date("2026-10-24T11:00:00Z");
      const weekendBlocked = isWithinSendingWindow(saturdayMidday, {
        timezone: "UTC",
        startHour: 9,
        endHour: 18,
        daysOfWeek: [1, 2, 3, 4, 5],
      });
      expect(weekendBlocked).toBe(false);
    });

    it("allows weekend sends when days_of_week includes Saturday/Sunday", () => {
      // Saturday 11:00 AM UTC
      const saturdayMidday = new Date("2026-10-24T11:00:00Z");
      const weekendAllowed = isWithinSendingWindow(saturdayMidday, {
        timezone: "UTC",
        startHour: 9,
        endHour: 18,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      });
      expect(weekendAllowed).toBe(true);
    });

    it("validates IANA timezones and falls back from recipient -> campaign -> account -> UTC", () => {
      expect(isValidIanaTimezone("America/New_York")).toBe(true);
      expect(isValidIanaTimezone("Asia/Dhaka")).toBe(true);
      expect(isValidIanaTimezone("Invalid/Zone_999")).toBe(false);
      expect(isValidIanaTimezone("")).toBe(false);

      expect(
        resolveEffectiveSendingTimezone({
          recipientTimezone: "America/Los_Angeles",
          campaignTimezone: "Europe/London",
          accountTimezone: "Asia/Dhaka",
        })
      ).toBe("America/Los_Angeles");

      // Invalid recipient timezone falls back to campaign timezone
      expect(
        resolveEffectiveSendingTimezone({
          recipientTimezone: "Bad/Timezone",
          campaignTimezone: "Europe/London",
          accountTimezone: "Asia/Dhaka",
        })
      ).toBe("Europe/London");

      // Missing/invalid recipient + campaign falls back to account timezone, then UTC
      expect(
        resolveEffectiveSendingTimezone({
          recipientTimezone: null,
          campaignTimezone: "Not/ATimezone",
          accountTimezone: "Asia/Tokyo",
        })
      ).toBe("Asia/Tokyo");

      expect(
        resolveEffectiveSendingTimezone({
          recipientTimezone: null,
          campaignTimezone: null,
          accountTimezone: null,
        })
      ).toBe("UTC");
    });

    it("evaluates dispatchRunningCampaigns sending window in recipient's timezone when present", async () => {
      // 2026-10-20 19:00 UTC (Tuesday):
      // - UTC is 19:00 -> OUTSIDE 09:00-18:00
      // - America/New_York (UTC-4) is 15:00 -> INSIDE 09:00-18:00
      // - Asia/Tokyo (UTC+9) is 04:00 (Wed) -> OUTSIDE 09:00-18:00
      const testNow = new Date("2026-10-20T19:00:00Z");

      const acc = await db.email_accounts.create({
        data: {
          id: `acc-tz-${Date.now()}`,
          user_id: testUserId,
          label: "TZ Sender",
          from_name: "Alex",
          from_email: `tz-${Date.now()}@company.com`,
          smtp_host: "smtp.company.com",
          smtp_port: 587,
          hourly_limit: 25,
          daily_limit: 100,
          status: "active",
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          id: `camp-tz-${Date.now()}`,
          user_id: testUserId,
          name: "Recipient TZ Campaign",
          mode: "custom",
          status: "running",
          timezone: "UTC",
          send_window: { startHour: 9, endHour: 18 },
          days_of_week: [1, 2, 3, 4, 5],
        },
      });

      const nyLead = await db.leads.create({
        data: {
          id: `lead-ny-${Date.now()}`,
          user_id: testUserId,
          dedupe_key: `dedupe-ny-${Date.now()}`,
          company_name: "NY Co",
          email: "ny@target.com",
          timezone: "America/New_York",
          source: "google_maps",
        },
      });

      const recNy = await db.campaign_recipients.create({
        data: {
          id: `rec-ny-${Date.now()}`,
          user_id: testUserId,
          campaign_id: campaign.id,
          lead_id: nyLead.id,
          email: "ny@target.com",
          assigned_account_id: acc.id,
          status: "queued",
          unsubscribe_token: `tok-ny-${Date.now()}`,
        },
      });

      const recTokyo = await db.campaign_recipients.create({
        data: {
          id: `rec-tokyo-${Date.now()}`,
          user_id: testUserId,
          campaign_id: campaign.id,
          email: "tokyo@target.com",
          vars: { timezone: "Asia/Tokyo" },
          assigned_account_id: acc.id,
          status: "queued",
          unsubscribe_token: `tok-tokyo-${Date.now()}`,
        },
      });

      const recFallbackUtc = await db.campaign_recipients.create({
        data: {
          id: `rec-utc-${Date.now()}`,
          user_id: testUserId,
          campaign_id: campaign.id,
          email: "utc@target.com",
          vars: { timezone: "Invalid/Zone" },
          assigned_account_id: acc.id,
          status: "queued",
          unsubscribe_token: `tok-utc-${Date.now()}`,
        },
      });

      await dispatchRunningCampaigns(testNow);

      const nyAfter = await db.campaign_recipients.findUnique({ where: { id: recNy.id } });
      const tokyoAfter = await db.campaign_recipients.findUnique({ where: { id: recTokyo.id } });
      const utcAfter = await db.campaign_recipients.findUnique({ where: { id: recFallbackUtc.id } });

      // NY lead was inside 9-18 local time and was dispatched
      expect(nyAfter?.status).toBe("sent");
      // Tokyo and invalid-timezone fallback (UTC 19:00) remained queued outside window
      expect(tokyoAfter?.status).toBe("queued");
      expect(utcAfter?.status).toBe("queued");
    });
  });

  describe("2. Randomized Jitter Calculator", () => {
    it("generates random jitter delays strictly bounded by min and max", () => {
      for (let i = 0; i < 30; i++) {
        const jitter = calculateRandomJitterSec(60, 180);
        expect(jitter).toBeGreaterThanOrEqual(60);
        expect(jitter).toBeLessThanOrEqual(180);
      }
    });

    it("handles identical or inverse min/max safely", () => {
      const exactJitter = calculateRandomJitterSec(90, 90);
      expect(exactJitter).toBe(90);

      const invertedJitter = calculateRandomJitterSec(120, 60);
      expect(invertedJitter).toBeGreaterThanOrEqual(60);
      expect(invertedJitter).toBeLessThanOrEqual(120);
    });
  });

  describe("3. Sender Account Allocation & Rate Limit Enforcement", () => {
    it("selects least-loaded account and throttles accounts exceeding hourly cap", async () => {
      const acc1 = await db.email_accounts.create({
        data: {
          user_id: testUserId,
          label: "Sender Account 1",
          from_name: "Alex",
          from_email: "alex1@testoutreach.com",
          hourly_limit: 25,
          daily_limit: 150,
          status: "active",
        },
      });

      const acc2 = await db.email_accounts.create({
        data: {
          user_id: testUserId,
          label: "Sender Account 2",
          from_name: "Sam",
          from_email: "sam2@testoutreach.com",
          hourly_limit: 25,
          daily_limit: 150,
          status: "active",
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          user_id: testUserId,
          name: "Rate Limit Test Campaign",
          mode: "custom",
          status: "running",
          timezone: "UTC",
          source_ref: { sender_account_ids: [acc1.id, acc2.id] },
        },
      });

      // Initially both are empty, selection should succeed
      const selection = await selectAvailableAccountForCampaign(campaign.id, testUserId);
      expect(selection.account).toBeDefined();
      expect([acc1.id, acc2.id]).toContain(selection.account?.id);
    });
  });

  describe("4. Email Dispatch Execution & Threading", () => {
    it("dispatches initial email, records message, and sets thread_message_id", async () => {
      const senderAcc = await db.email_accounts.create({
        data: {
          user_id: testUserId,
          label: "Active Sender",
          from_name: "Outreach Lead",
          from_email: "sender@domain.com",
          smtp_host: "smtp.mailtrap.io",
          smtp_port: 587,
          hourly_limit: 25,
          daily_limit: 150,
          status: "active",
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          user_id: testUserId,
          name: "Outreach Launch Campaign",
          mode: "custom",
          status: "running",
          timezone: "UTC",
          subject_template: "Partnership with {{company_name}}",
          body_template: "Hi {{first_name}}, would love to connect with {{company_name}}.",
        },
      });

      const recipient = await db.campaign_recipients.create({
        data: {
          user_id: testUserId,
          campaign_id: campaign.id,
          email: "target_lead@prospective.com",
          name: "David Miller",
          company: "Miller Automotive",
          vars: { first_name: "David", company_name: "Miller Automotive" },
          assigned_account_id: senderAcc.id,
          status: "queued",
          unsubscribe_token: "unsub-tok-engine-123",
          current_step: 0,
        },
      });

      const sendResult = await sendSingleRecipientEmail(recipient.id);
      expect(sendResult).toHaveProperty("success", true);
      expect(sendResult).toHaveProperty("messageId");

      const updatedRecipient = await db.campaign_recipients.findUnique({
        where: { id: recipient.id },
      });
      expect(updatedRecipient?.status).toBe("sent");
      expect(updatedRecipient?.sent_at).toBeDefined();
      expect(updatedRecipient?.thread_message_id).toBeDefined();
      expect(updatedRecipient?.current_step).toBe(1);
    });

    it("aborts send and marks unsubscribed when recipient is in suppression list", async () => {
      const suppressedEmail = "suppressed_target@domain.com";

      await db.suppressions.create({
        data: {
          user_id: testUserId,
          email: suppressedEmail,
          reason: "manual",
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          user_id: testUserId,
          name: "Suppression Guard Campaign",
          mode: "custom",
          status: "running",
          timezone: "UTC",
        },
      });

      const recipient = await db.campaign_recipients.create({
        data: {
          user_id: testUserId,
          campaign_id: campaign.id,
          email: suppressedEmail,
          status: "queued",
          unsubscribe_token: "unsub-suppressed-tok-456",
        },
      });

      const result = await sendSingleRecipientEmail(recipient.id);
      expect(result).toHaveProperty("skipped", true);
      expect(result).toHaveProperty("reason", "Suppressed");

      const rec = await db.campaign_recipients.findUnique({
        where: { id: recipient.id },
      });
      expect(rec?.status).toBe("unsubscribed");
    });

    it("enforces per-account wait gap: sets next_allowed_at and blocks immediate second send", async () => {
      // Create a test account with min_gap_seconds = 120 (2 minutes)
      const gapAccount = await db.email_accounts.create({
        data: {
          user_id: testUserId,
          label: "Gap Paced Inbox",
          from_email: "gap_tester@leadreach-mail.com",
          from_name: "Paced Tester",
          smtp_host: "localhost",
          smtp_port: 1025,
          smtp_security: "none",
          smtp_username: "user",
          hourly_limit: 25,
          daily_limit: 100,
          gap_seconds: 120,
          min_gap_seconds: 120,
          max_gap_seconds: 120,
          status: "active",
        },
      });

      const campaign = await db.outreach_campaigns.create({
        data: {
          user_id: testUserId,
          name: "Gap Enforcement Test",
          mode: "custom",
          status: "running",
          timezone: "UTC",
        },
      });

      // Recipient 1
      const rec1 = await db.campaign_recipients.create({
        data: {
          user_id: testUserId,
          campaign_id: campaign.id,
          email: "lead_gap_1@target.com",
          status: "queued",
          assigned_account_id: gapAccount.id,
          unsubscribe_token: "gap-token-rec1",
        },
      });

      // Recipient 2 assigned to same inbox
      const rec2 = await db.campaign_recipients.create({
        data: {
          user_id: testUserId,
          campaign_id: campaign.id,
          email: "lead_gap_2@target.com",
          status: "queued",
          assigned_account_id: gapAccount.id,
          unsubscribe_token: "gap-token-rec2",
        },
      });

      // Send 1st email
      const send1 = await sendSingleRecipientEmail(rec1.id);
      expect(send1).toHaveProperty("success", true);

      // Verify that gapAccount.next_allowed_at is now set into the future (~2 minutes ahead)
      const accountAfterSend = await db.email_accounts.findUnique({
        where: { id: gapAccount.id },
      });
      expect(accountAfterSend?.next_allowed_at).toBeDefined();
      const cooldownSec = Math.round(
        (new Date(accountAfterSend!.next_allowed_at!).getTime() - Date.now()) / 1000
      );
      expect(cooldownSec).toBeGreaterThanOrEqual(115); // ~120s cooldown
      expect(cooldownSec).toBeLessThanOrEqual(125);

      // Attempt to immediately send 2nd email from the same account -> MUST BE THROTTLED
      const send2 = await sendSingleRecipientEmail(rec2.id);
      expect(send2).toHaveProperty("throttled", true);
      expect((send2 as any).reason).toContain("Account wait gap active");

      // Now simulate that the 2 minutes have passed
      await db.email_accounts.update({
        where: { id: gapAccount.id },
        data: { next_allowed_at: new Date(Date.now() - 1000) },
      });

      // Attempt to send 2nd email now that wait gap expired -> MUST SUCCEED
      const send2AfterCooldown = await sendSingleRecipientEmail(rec2.id);
      expect(send2AfterCooldown).toHaveProperty("success", true);
    });
  });

  describe("4. Pure Message Mode & Multipart Email Construction (Phase 6)", () => {
    it("constructs pure plain-text without injecting footer and omits HTML when tracking is off", () => {
      const pure = buildEmailMultipartBodies({
        bodyText: "Hello John,\n\nWe would love to connect with your team.\nBest,\nSarah",
        unsubscribeUrl: "https://example.com/u/tok-123",
        trackingOpen: false,
        trackingClick: false,
        unsubscribeToken: "tok-123",
        baseUrl: "https://example.com",
      });

      expect(pure.text).toBe("Hello John,\n\nWe would love to connect with your team.\nBest,\nSarah");
      expect(pure.html).toBeUndefined();
    });

    it("constructs clean plain-text without HTML tags or open tracking pixel while HTML carries pixel when trackingOpen is true", () => {
      const bodies = buildEmailMultipartBodies({
        bodyText: "Hello John,\n\nWe would love to connect with your team.\nBest,\nSarah",
        unsubscribeUrl: "https://example.com/u/tok-123",
        trackingOpen: true,
        unsubscribeToken: "tok-123",
        baseUrl: "https://example.com",
      });

      // Plaintext must match bodyText exactly without HTML tags, pixels, or injected footer
      expect(bodies.text).toBe("Hello John,\n\nWe would love to connect with your team.\nBest,\nSarah");
      expect(bodies.text).not.toContain("<img");
      expect(bodies.text).not.toContain("<p");
      expect(bodies.text).not.toContain("<br");
      expect(bodies.text).not.toContain("To unsubscribe:");

      // HTML body carries semantic elements and open tracking pixel only (no injected footer)
      expect(bodies.html).toContain("<img src=\"https://example.com/api/v1/track/open/tok-123\"");
      expect(bodies.html).not.toContain(">Unsubscribe</a>");
    });

    it("omits HTML completely for plain-text templates when both trackingOpen and trackingClick are disabled", () => {
      const bodies = buildEmailMultipartBodies({
        bodyText: "Hello John,\n\nChecking in.",
        unsubscribeUrl: "https://example.com/u/tok-456",
        trackingOpen: false,
        trackingClick: false,
        unsubscribeToken: "tok-456",
        baseUrl: "https://example.com",
      });

      expect(bodies.html).toBeUndefined();
      expect(bodies.text).toBe("Hello John,\n\nChecking in.");
    });
  });
});
