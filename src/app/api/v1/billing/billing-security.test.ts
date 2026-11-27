import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { POST as webhookPost } from "./webhooks/[provider]/route";
import { POST as cancelPost } from "./cancel/route";
import { ManualPaymentProvider } from "@/server/billing/providers/manual-provider";

const mockGetSessionUser = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

describe("SEC-001 & BUG-025 Billing Security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated/unsigned requests to POST /api/v1/billing/webhooks/manual with 403", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/billing/webhooks/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment.paid",
        id: "evt_attack_1",
        payment_id: "pay_123",
        status: "succeeded",
      }),
    });

    const res = await webhookPost(req, { params: Promise.resolve({ provider: "manual" }) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/disabled|forbidden/i);

    const provider = new ManualPaymentProvider();
    const directRes = await provider.handleWebhook(
      JSON.stringify({ type: "payment.paid", payment_id: "pay_123" }),
      {}
    );
    expect(directRes.handled).toBe(false);
  });

  it("rejects unauthenticated requests to POST /api/v1/billing/cancel with 401", async () => {
    mockGetSessionUser.mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost:3000/api/v1/billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId: "sub-1" }),
    });

    const res = await cancelPost(req);
    expect(res.status).toBe(401);
  });

  it("prevents user A from canceling user B's subscription (cross-tenant 404)", async () => {
    const userBSub = await db.subscriptions.create({
      data: {
        user_id: "user-b-billing",
        plan_id: "plan-pro",
        status: "active",
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 30 * 86400_000),
        provider: "manual",
      },
    });

    mockGetSessionUser.mockResolvedValueOnce({ user: { id: "user-a-billing" } });
    const req = new NextRequest("http://localhost:3000/api/v1/billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId: userBSub.id }),
    });

    const res = await cancelPost(req);
    expect(res.status).toBe(404);

    const stillActive = await db.subscriptions.findUnique({ where: { id: userBSub.id } });
    expect(stillActive?.cancel_at_period_end).toBe(false);
  });

  it("allows authenticated user to cancel their own subscription", async () => {
    const userASub = await db.subscriptions.create({
      data: {
        user_id: "user-a-own",
        plan_id: "plan-pro",
        status: "active",
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 30 * 86400_000),
        provider: "manual",
      },
    });

    mockGetSessionUser.mockResolvedValueOnce({ user: { id: "user-a-own" } });
    const req = new NextRequest("http://localhost:3000/api/v1/billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId: userASub.id }),
    });

    const res = await cancelPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.cancelAtPeriodEnd).toBe(true);

    const updated = await db.subscriptions.findUnique({ where: { id: userASub.id } });
    expect(updated?.cancel_at_period_end).toBe(true);
  });

  it("stores target plan_id and yearly interval in payment.method_details when manual checkout is for a different plan", async () => {
    await db.subscriptions.create({
      data: {
        user_id: "user-upgrade-1",
        plan_id: "plan-starter",
        status: "active",
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 10 * 86400_000),
        provider: "manual",
      },
    });

    const provider = new ManualPaymentProvider();
    const result = await provider.createCheckout({
      userId: "user-upgrade-1",
      userEmail: "upgrade@example.com",
      planId: "plan-growth",
      planSlug: "growth",
      planName: "Growth",
      amount: 790,
      currency: "USD",
      interval: "yearly",
      successUrl: "http://localhost:3000/success",
      cancelUrl: "http://localhost:3000/cancel",
    });

    const payment = await db.payments.findUnique({ where: { id: result.sessionId } });
    expect(payment).toBeTruthy();
    const details = payment?.method_details as Record<string, any>;
    expect(details.plan_id).toBe("plan-growth");
    expect(details.interval).toBe("yearly");
  });
});
