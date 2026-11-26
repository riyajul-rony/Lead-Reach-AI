import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/server/db";
import {
  detectDeterministicOptOut,
  extractFirstNonQuotedLine,
} from "@/server/email/opt-out-detector";
import { recordHumanReplyAndClassify } from "@/server/worker/reply-poller";

const { mockClassify } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
}));

vi.mock("@/server/ai/reply-classifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai/reply-classifier")>();
  return {
    ...actual,
    classifyReplyIntent: (...args: any[]) => mockClassify(...args),
  };
});

describe("Phase 6 Task 4: Conservative Deterministic Opt-Out Reply Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassify.mockResolvedValue({
      category: "uncategorized",
      confidence: null,
      source: "fallback",
    });
  });

  describe("1. Explicit deterministic matches", () => {
    it.each([
      "stop",
      "Stop.",
      "STOP!!!",
      "please stop",
      "unsubscribe",
      "Unsubscribe.",
      "please unsubscribe me",
      "remove me",
      "Please remove me.",
      "not interested, stop",
      "Not interested - stop",
      "opt out",
      "please opt me out",
      "\n\n  Unsubscribe  \n\nOn Mon, Alex wrote:\n> Hey",
    ])("detects explicit opt-out on first non-quoted line: %j", (body) => {
      const res = detectDeterministicOptOut(body);
      expect(res.isOptOut).toBe(true);
    });
  });

  describe("2. Strict false-positive rejection & multilingual safety", () => {
    it.each([
      "don't stop now",
      "Please don't stop emailing updates, I love this.",
      "please don't unsubscribe me",
      "Please do not remove me from your newsletter",
      "Can you stop by our office Tuesday?",
      "Don't stop, keep sending case studies next month.",
      "We are not interested right now, maybe next quarter.",
      "The unsubscribe link worked well for our old CRM, let's chat.",
      "Could you please remove me only from the billing cc, not this thread?",
      "Sounds great, let's talk Thursday.\n\nOn Mon, Alex wrote:\n> Reply STOP to opt out",
      "Bonjour Alex, merci pour votre message. Je suis disponible mardi.",
      "Hola, muchas gracias por escribirme. Hablemos la próxima semana.",
      "Hallo Alex, danke für die Nachricht — bitte senden Sie mehr Infos.",
      "ধন্যবাদ, আগামী সপ্তাহে কথা বলা যাবে।",
      "ご連絡ありがとうございます。来週お話ししましょう。",
      "",
      "   \n> Unsubscribe\n",
    ])("does NOT false-positive on: %j", (body) => {
      const res = detectDeterministicOptOut(body);
      expect(res.isOptOut).toBe(false);
    });

    it("ignores quoted opt-out lines inside reply thread history", () => {
      const body = [
        "Thanks Alex, please send pricing for 10 seats.",
        "",
        "On Tue, Nov 25, 2026 at 9:00 AM Alex <alex@agency.com> wrote:",
        "> Stop",
        "> Unsubscribe",
      ].join("\n");

      expect(extractFirstNonQuotedLine(body)).toBe(
        "Thanks Alex, please send pricing for 10 seats."
      );
      expect(detectDeterministicOptOut(body).isOptOut).toBe(false);
    });
  });

  describe("3. Worker reply processing & AI non-auto-suppression invariant", () => {
    it("stops follow-ups immediately, marks unsubscribed, and adds to suppressions on deterministic opt-out", async () => {
      const userId = "optout-user-1";
      const camp = await db.outreach_campaigns.create({
        data: {
          user_id: userId,
          name: "OptOut Integration",
          mode: "custom",
          status: "running",
          timezone: "UTC",
        },
      });
      const rec = await db.campaign_recipients.create({
        data: {
          user_id: userId,
          campaign_id: camp.id,
          email: "optout_lead@company.com",
          status: "sent",
          next_followup_at: new Date(Date.now() + 86400000),
          unsubscribe_token: "tok-optout-1",
        },
      });

      const res = await recordHumanReplyAndClassify({
        recipient: rec,
        accountId: "acc-optout-1",
        messageId: `<optout-msg-${Date.now()}@company.com>`,
        subject: "Re: Partnership",
        bodyText: "Please remove me.\n\nOn Mon wrote:\n> Original note",
      });

      expect(res.recorded).toBe(true);
      expect(res.optedOut).toBe(true);
      expect(res.category).toBe("unsubscribe");
      expect(mockClassify).not.toHaveBeenCalled();

      const updated = await db.campaign_recipients.findUnique({ where: { id: rec.id } });
      expect(updated?.status).toBe("unsubscribed");
      expect(updated?.next_followup_at).toBeNull();
      expect(updated?.reply_category).toBe("unsubscribe");

      const sup = await db.suppressions.findFirst({
        where: { user_id: userId, email: "optout_lead@company.com" },
      });
      expect(sup).not.toBeNull();
      expect(sup?.reason).toBe("unsubscribed");
    });

    it("preserves Stop-on-Reply BEFORE AI classification and never auto-suppresses from AI alone", async () => {
      const userId = "optout-user-2";
      const camp = await db.outreach_campaigns.create({
        data: {
          user_id: userId,
          name: "AI Guard Integration",
          mode: "custom",
          status: "running",
          timezone: "UTC",
        },
      });
      const rec = await db.campaign_recipients.create({
        data: {
          user_id: userId,
          campaign_id: camp.id,
          email: "ambiguous_lead@company.com",
          status: "sent",
          next_followup_at: new Date(Date.now() + 86400000),
          unsubscribe_token: "tok-ai-guard-1",
        },
      });

      let statusDuringAiCall: string | undefined;
      mockClassify.mockImplementationOnce(async () => {
        const snapshot = await db.campaign_recipients.findUnique({ where: { id: rec.id } });
        statusDuringAiCall = snapshot?.status;
        return { category: "unsubscribe", confidence: 0.91, source: "ai" };
      });

      const res = await recordHumanReplyAndClassify({
        recipient: rec,
        accountId: "acc-optout-2",
        messageId: `<ai-guard-msg-${Date.now()}@company.com>`,
        subject: "Re: Question",
        bodyText: "Don't stop now, just reach back out in Q4 please.",
      });

      expect(res.recorded).toBe(true);
      expect(res.optedOut).toBe(false);
      // Stop-on-Reply was ALREADY committed before AI classification began
      expect(statusDuringAiCall).toBe("replied");

      const sup = await db.suppressions.findFirst({
        where: { user_id: userId, email: "ambiguous_lead@company.com" },
      });
      expect(sup).toBeNull();
    });
  });
});
