import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { prepareReplyTextForAi, classifyReplyIntent } from "./reply-classifier";
import { recordHumanReplyAndClassify } from "@/server/worker/reply-poller";
import * as CategoryRoute from "@/app/api/v1/replies/[id]/category/route";

const { mockCompletionsCreate, mockSession } = vi.hoisted(() => ({
  mockCompletionsCreate: vi.fn(),
  mockSession: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCompletionsCreate,
      },
    };
  }
  return { default: MockOpenAI };
});

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

describe("Phase 3 Step 3: AI Reply Categorization", () => {
  const userId = "user-ai-reply-1";

  beforeEach(() => {
    mockCompletionsCreate.mockReset();
    delete process.env.REPLY_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLY_AI_PROVIDER;
    mockSession.mockResolvedValue({ user: { id: userId, email: "owner@company.com" } });
  });

  it("strips quoted thread history and truncates body to 2000 characters", () => {
    const longText = "A".repeat(2500);
    const raw = `${longText}\n\nOn Tue, Nov 25, 2026 at 10:00 AM Sender <a@b.com> wrote:\n> Previous quoted email`;
    const cleaned = prepareReplyTextForAi(raw, 2000);
    expect(cleaned.length).toBe(2000);
    expect(cleaned).not.toContain("Previous quoted email");

    const quotedBody = "Yes, let's schedule a call tomorrow.\n> On Mon wrote:\n> Old email text";
    expect(prepareReplyTextForAi(quotedBody, 2000)).toBe("Yes, let's schedule a call tomorrow.");
  });

  it("falls back safely to uncategorized when API key is missing or OpenAI errors/times out", async () => {
    // Missing key
    const noKeyRes = await classifyReplyIntent({
      userId: "user-without-any-key",
      subject: "Re: Intro",
      bodyText: "Sounds great!",
    });
    expect(noKeyRes.category).toBe("uncategorized");
    expect(mockCompletionsCreate).not.toHaveBeenCalled();

    // Error / rate limit
    process.env.REPLY_AI_API_KEY = "sk-test-dummy-key";
    mockCompletionsCreate.mockRejectedValueOnce(new Error("429 Rate limit exceeded"));
    const errRes = await classifyReplyIntent({
      userId,
      subject: "Re: Intro",
      bodyText: "Sounds great!",
    });
    expect(errRes.category).toBe("uncategorized");
  });

  it("runs Stop-on-Reply BEFORE AI classification and never auto-suppresses on AI unsubscribe prediction", async () => {
    const camp = await db.outreach_campaigns.create({
      data: {
        id: "camp-ai-cat-1",
        user_id: userId,
        name: "AI Cat Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
      },
    });

    // Case 1: AI errors out -> Stop-on-Reply STILL happened and reply is uncategorized
    const rec1 = await db.campaign_recipients.create({
      data: {
        id: "rec-ai-fallback",
        user_id: userId,
        campaign_id: camp.id,
        email: "lead_fallback@target.com",
        status: "sent",
        next_followup_at: new Date(Date.now() + 86400000),
        unsubscribe_token: "tok-ai-fallback-123456",
      },
    });

    process.env.REPLY_AI_API_KEY = "sk-test-dummy-key";
    mockCompletionsCreate.mockRejectedValueOnce(new Error("Timeout"));

    const res1 = await recordHumanReplyAndClassify({
      recipient: rec1,
      accountId: "acc-1",
      messageId: `<reply-1-${Date.now()}@target.com>`,
      subject: "Re: Proposal",
      bodyText: "Can you tell me more about pricing?",
    });

    expect(res1.recorded).toBe(true);
    expect(res1.category).toBe("uncategorized");
    const updatedRec1 = await db.campaign_recipients.findUnique({ where: { id: rec1.id } });
    expect(updatedRec1?.status).toBe("replied");
    expect(updatedRec1?.next_followup_at).toBeNull();

    // Case 2: AI classifies as 'unsubscribe' -> tagged as 'unsubscribe' for manual review, NEVER auto-suppressed
    const rec2 = await db.campaign_recipients.create({
      data: {
        id: "rec-ai-unsub",
        user_id: userId,
        campaign_id: camp.id,
        email: "lead_ai_unsub@target.com",
        status: "sent",
        next_followup_at: new Date(Date.now() + 86400000),
        unsubscribe_token: "tok-ai-unsub-123456",
      },
    });

    mockCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ category: "unsubscribe", confidence: 0.94 }) } }],
    });

    const res2 = await recordHumanReplyAndClassify({
      recipient: rec2,
      accountId: "acc-1",
      messageId: `<reply-2-${Date.now()}@target.com>`,
      subject: "Re: Proposal",
      bodyText: "Please take me off your list",
    });

    expect(res2.recorded).toBe(true);
    expect(res2.category).toBe("unsubscribe");
    const updatedRec2 = await db.campaign_recipients.findUnique({ where: { id: rec2.id } });
    expect(updatedRec2?.status).toBe("replied");
    expect(updatedRec2?.reply_category).toBe("unsubscribe");

    // Verify NOT auto-added to suppressions
    const sup = await db.suppressions.findFirst({
      where: { user_id: userId, email: "lead_ai_unsub@target.com" },
    });
    expect(sup).toBeNull();
  });

  it("allows authenticated owner to manually override reply category and blocks other tenants", async () => {
    const msg = await db.email_messages.create({
      data: {
        id: "msg-manual-override-1",
        user_id: userId,
        email_account_id: "acc-1",
        direction: "in",
        kind: "reply",
        message_id: `<manual-ov-${Date.now()}@target.com>`,
        subject: "Re: Hello",
        status: "received",
        reply_category: "uncategorized",
      },
    });

    // Wrong user -> 404
    mockSession.mockResolvedValueOnce({ user: { id: "other-user-999", email: "other@evil.com" } });
    const reqOther = new NextRequest(`http://localhost:3000/api/v1/replies/${msg.id}/category`, {
      method: "PATCH",
      body: JSON.stringify({ category: "interested" }),
    });
    const resOther = await CategoryRoute.PATCH(reqOther, { params: Promise.resolve({ id: msg.id }) });
    expect(resOther.status).toBe(404);

    // Real owner -> 200
    mockSession.mockResolvedValueOnce({ user: { id: userId, email: "owner@company.com" } });
    const reqOk = new NextRequest(`http://localhost:3000/api/v1/replies/${msg.id}/category`, {
      method: "PATCH",
      body: JSON.stringify({ category: "interested" }),
    });
    const resOk = await CategoryRoute.PATCH(reqOk, { params: Promise.resolve({ id: msg.id }) });
    expect(resOk.status).toBe(200);
    const jsonOk = await resOk.json();
    expect(jsonOk.data.reply_category).toBe("interested");
    expect(jsonOk.data.reply_category_source).toBe("manual");
  });
});
