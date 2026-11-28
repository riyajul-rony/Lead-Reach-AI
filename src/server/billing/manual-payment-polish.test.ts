import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";

const {
  mockSession,
  mockSendSystemMail,
  mockConfigOverrides,
} = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockSendSystemMail: vi.fn(),
  mockConfigOverrides: new Map<string, string | undefined>(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Map<string, string>([
      ["x-forwarded-for", "127.0.0.1"],
    ]),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err: any = new Error(`NEXT_REDIRECT:${url}`);
    err.digest = `NEXT_REDIRECT;push;${url};307;`;
    throw err;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockSession(),
  };
});

vi.mock("@/server/email/system-mailer", () => ({
  sendSystemMail: (...args: any[]) => mockSendSystemMail(...args),
}));

vi.mock("@/server/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/config")>();
  return {
    ...actual,
    getConfig: async (key: any) => {
      if (mockConfigOverrides.has(key)) {
        return mockConfigOverrides.get(key);
      }
      return actual.getConfig(key);
    },
    getAppUrl: async () => "http://localhost:3000",
    getMaintenanceMode: async () => ({ active: false, message: "" }),
  };
});

import { POST as checkoutPOST } from "@/app/api/v1/billing/checkout/route";
import { POST as manualSubmitPOST } from "@/app/api/v1/billing/manual/submit/route";
import { POST as webhookPOST } from "@/app/api/v1/billing/webhooks/[provider]/route";
import {
  approveManualPaymentAction,
  rejectManualPaymentAction,
  saveManualPaymentSettingsAction,
} from "@/app/admin/billing/billing-actions";
import {
  expireOverdueSubscriptions,
  processSubscriptionLifecycles,
  sendRenewalReminders,
} from "@/server/billing/lifecycle";
import { assertTrialActive, getTrialStatus } from "@/server/billing/trial";
import { ManualPaymentProvider } from "@/server/billing/providers/manual-provider";
import { invalidateSettingCache } from "@/server/config";

describe("Manual Payment Polish & Renewal Lifecycle", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  async function seedPlan(overrides: Partial<any> = {}) {
    const id = overrides.id || uid("plan");
    return db.plans.create({
      data: {
        id,
        name: overrides.name || "Pro Plan",
        slug: overrides.slug || `pro-${seq}`,
        monthly_price: overrides.monthly_price ?? 49,
        yearly_price: overrides.yearly_price ?? 490,
        currency: "USD",
        is_active: true,
        monthly_leads: 2500,
        monthly_social_posts: 120,
        monthly_outreach_emails: 2500,
        max_social_accounts: 5,
        max_email_accounts: 5,
        max_campaigns: 20,
        ...overrides,
      },
    });
  }

  async function seedUser(overrides: Partial<any> = {}) {
    const id = overrides.id || uid("user");
    return db.users.create({
      data: {
        id,
        email: overrides.email || `${id}@test.io`,
        name: overrides.name || "Test User",
        role: overrides.role || "user",
        status: overrides.status || "active",
        plan: overrides.plan || "free",
        email_verified_at: "email_verified_at" in overrides ? overrides.email_verified_at : new Date(),
        onboarded_at: new Date(),
        ...overrides,
      },
    });
  }

  async function configureManualPayment(opts?: { usdToBdtRate?: number | null }) {
    const admin = await seedUser({ role: "admin", plan: "enterprise" });
    mockSession.mockResolvedValue({ user: admin });
    const res = await saveManualPaymentSettingsAction({
      bkashNumber: "01811223344",
      nagadNumber: "01955667788",
      bankName: "City Bank",
      bankAccountName: "Lead Reach Ltd",
      bankAccountNumber: "2100998877",
      note: "Use invoice number in reference",
      usdToBdtRate: opts?.usdToBdtRate ?? 120,
    });
    expect(res.success).toBe(true);
    return admin;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfigOverrides.clear();
    mockSendSystemMail.mockResolvedValue({ ok: true });
    await db.system_settings.deleteMany({ where: { key: "MANUAL_PAYMENT_CONFIG" } });
    await invalidateSettingCache("MANUAL_PAYMENT_CONFIG");
  });

  it("removes all hardcoded placeholder numbers and returns unconfigured instructions when not set up", async () => {
    const user = await seedUser();
    const plan = await seedPlan({ slug: `starter-${seq}` });

    const provider = new ManualPaymentProvider();
    const res = await provider.createCheckout({
      userId: user.id,
      userEmail: user.email,
      planId: plan.id,
      planSlug: plan.slug,
      planName: plan.name,
      amount: 29,
      currency: "USD",
      interval: "monthly",
      successUrl: "http://localhost:3000/success",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(res.configured).toBe(false);
    expect(res.instructionHtml).toBe("");
    expect(res.instructionHtml).not.toContain("01700-000000");
    expect(res.instructionHtml).not.toContain("123456789");
    expect(res.instructionHtml).not.toContain("987654321");
  });

  it("reuses a single open pending payment per (user, plan), rejects duplicate TrxIDs, and blocks cross-user access", async () => {
    await configureManualPayment({ usdToBdtRate: 120 });
    const userA = await seedUser({ name: "User A" });
    const userB = await seedUser({ name: "User B" });
    const plan = await seedPlan({ monthly_price: 49, yearly_price: 490 });

    // User A starts checkout twice for the same plan -> single open pending payment reused
    mockSession.mockResolvedValue({ user: userA });
    const c1 = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "monthly" }),
      })
    );
    expect(c1.status).toBe(200);
    const j1 = await c1.json();
    expect(j1.data.bdtAmount).toBe(5880); // 49 * 120

    const c2 = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "yearly" }),
      })
    );
    expect(c2.status).toBe(200);
    const j2 = await c2.json();
    expect(j2.data.sessionId).toBe(j1.data.sessionId);
    expect(j2.data.bdtAmount).toBe(58800); // 490 * 120

    const openPending = await db.payments.findMany({
      where: { user_id: userA.id, status: "pending" },
    });
    expect(openPending).toHaveLength(1);

    // User B cannot submit against User A's payment
    mockSession.mockResolvedValue({ user: userB });
    const crossUserSubmit = await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: j1.data.sessionId,
          method: "bkash",
          transactionId: "TRXUNIQUE100",
          senderNumber: "01711112222",
        }),
      })
    );
    expect(crossUserSubmit.status).toBe(404);

    // User A submits valid payment details
    mockSession.mockResolvedValue({ user: userA });
    const subA = await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: j1.data.sessionId,
          method: "bkash",
          transactionId: "TrxDupCheck01",
          senderNumber: "01711112222",
          note: "Paid via bKash",
        }),
      })
    );
    expect(subA.status).toBe(200);

    // User B creates their own checkout and tries to reuse the same TrxID (case-insensitive) -> 409
    mockSession.mockResolvedValue({ user: userB });
    const cB = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "monthly" }),
      })
    );
    const jB = await cB.json();

    const dupRes = await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: jB.data.sessionId,
          method: "bkash",
          transactionId: "trxdupcheck01",
          senderNumber: "01799998888",
        }),
      })
    );
    expect(dupRes.status).toBe(409);
  });

  it("enforces billing.manage on admin actions, writes audit logs, approves idempotently (365d yearly + same-plan extension), and survives mail failures", async () => {
    const admin = await configureManualPayment();
    const supportUser = await seedUser({ role: "support" });
    const regularUser = await seedUser({ role: "user" });
    const plan = await seedPlan({ slug: `growth-${seq}`, monthly_price: 79, yearly_price: 790 });

    // Non-billing.manage users are blocked from saving settings, approving, or rejecting
    mockSession.mockResolvedValue({ user: regularUser });
    await expect(
      saveManualPaymentSettingsAction({ bkashNumber: "01000000000" })
    ).rejects.toThrow(/NEXT_REDIRECT/);

    mockSession.mockResolvedValue({ user: supportUser });
    await expect(approveManualPaymentAction("pay-missing")).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(rejectManualPaymentAction("pay-missing", "bad")).rejects.toThrow(/NEXT_REDIRECT/);

    // Regular user submits a yearly payment
    mockSession.mockResolvedValue({ user: regularUser });
    const checkoutRes = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "yearly" }),
      })
    );
    const { data: checkout } = await checkoutRes.json();

    await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: checkout.sessionId,
          method: "bank",
          transactionId: "BANKREF365A",
          senderNumber: "9988776655",
        }),
      })
    );

    // Even if receipt email fails, approval succeeds
    mockSendSystemMail.mockRejectedValueOnce(new Error("SMTP offline"));
    mockSession.mockResolvedValue({ user: admin });

    const approve1 = await approveManualPaymentAction(checkout.sessionId);
    expect(approve1.success).toBe(true);
    expect((approve1 as any).alreadyApproved).toBe(false);

    const updatedUser = await db.users.findUnique({ where: { id: regularUser.id } });
    expect(updatedUser?.plan).toBe(plan.slug);
    expect(updatedUser?.plan_id).toBe(plan.id);

    const subAfterFirst = await db.subscriptions.findFirst({ where: { user_id: regularUser.id } });
    expect(subAfterFirst?.status).toBe("active");
    const firstEndMs = new Date(subAfterFirst!.current_period_end).getTime();
    const approxYearMs = 365 * 86_400_000;
    expect(firstEndMs - Date.now()).toBeGreaterThan(approxYearMs - 60_000);
    expect(firstEndMs - Date.now()).toBeLessThan(approxYearMs + 60_000);

    // Double click approve -> idempotent, does NOT extend again
    const approve2 = await approveManualPaymentAction(checkout.sessionId);
    expect(approve2.success).toBe(true);
    expect((approve2 as any).alreadyApproved).toBe(true);
    const subAfterSecond = await db.subscriptions.findFirst({ where: { user_id: regularUser.id } });
    expect(new Date(subAfterSecond!.current_period_end).getTime()).toBe(firstEndMs);

    // Same-plan monthly renewal extends from current_period_end (firstEndMs + 30 days)
    mockSession.mockResolvedValue({ user: regularUser });
    const renewCheckout = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "monthly" }),
      })
    );
    const { data: renewData } = await renewCheckout.json();
    await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: renewData.sessionId,
          method: "nagad",
          transactionId: "NAGADEXTEND01",
          senderNumber: "01900001111",
        }),
      })
    );

    mockSession.mockResolvedValue({ user: admin });
    const approveRenew = await approveManualPaymentAction(renewData.sessionId);
    expect(approveRenew.success).toBe(true);

    const subAfterRenew = await db.subscriptions.findFirst({ where: { user_id: regularUser.id } });
    expect(new Date(subAfterRenew!.current_period_end).getTime()).toBe(firstEndMs + 30 * 86_400_000);

    // Audit log recorded
    const auditLogs = await db.admin_audit_logs.findMany({
      where: { action: "billing.manual_payment_approved" },
    });
    expect(auditLogs.some((l: any) => l.target_id === checkout.sessionId)).toBe(true);
    expect(auditLogs.some((l: any) => l.target_id === renewData.sessionId)).toBe(true);
  });

  it("rejects a payment with a reason without modifying subscription, notifies user, and keeps public webhook blocked", async () => {
    const admin = await configureManualPayment();
    const user = await seedUser();
    const plan = await seedPlan();

    mockSession.mockResolvedValue({ user });
    const cRes = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "monthly" }),
      })
    );
    const { data: checkout } = await cRes.json();

    await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: checkout.sessionId,
          method: "bkash",
          transactionId: "BADTRX1234",
          senderNumber: "01712345678",
        }),
      })
    );

    mockSession.mockResolvedValue({ user: admin });
    const rejRes = await rejectManualPaymentAction(checkout.sessionId, "Transaction ID mismatch");
    expect(rejRes.success).toBe(true);

    const rejectedPay = await db.payments.findUnique({ where: { id: checkout.sessionId } });
    expect(rejectedPay?.status).toBe("failed");
    expect((rejectedPay?.method_details as any)?.rejection_reason).toBe("Transaction ID mismatch");

    // User stays on free with no active subscription
    const uAfter = await db.users.findUnique({ where: { id: user.id } });
    expect(uAfter?.plan).toBe("free");
    expect(await db.subscriptions.findFirst({ where: { user_id: user.id } })).toBeNull();

    // Rejection email sent with reason
    expect(
      mockSendSystemMail.mock.calls.some(
        (c) => c[0].to === user.email && String(c[0].text).includes("Transaction ID mismatch")
      )
    ).toBe(true);

    // Public manual webhook remains blocked (403)
    const whRes = await webhookPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/webhooks/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "payment.paid", payment_id: checkout.sessionId }),
      }),
      { params: Promise.resolve({ provider: "manual" }) }
    );
    expect(whRes.status).toBe(403);
  });

  it("notifies billing.manage admins once per submitted payment via in-app notice and email when SMTP is configured", async () => {
    const superAdmin = await seedUser({ role: "super_admin", plan: "enterprise" });
    const financeAdmin = await seedUser({ role: "finance", plan: "enterprise" });
    const supportStaff = await seedUser({ role: "support", plan: "enterprise" });
    await configureManualPayment();

    mockConfigOverrides.set("SYSTEM_SMTP_HOST", "smtp.example.com");
    mockConfigOverrides.set("SYSTEM_SMTP_FROM", "noreply@example.com");

    const payer = await seedUser({ name: "Payer One" });
    const plan = await seedPlan();
    mockSession.mockResolvedValue({ user: payer });

    const cRes = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval: "monthly" }),
      })
    );
    const { data: checkout } = await cRes.json();

    const sRes = await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: checkout.sessionId,
          method: "bkash",
          transactionId: "ADMINNOTIFY01",
          senderNumber: "01700112233",
        }),
      })
    );
    expect(sRes.status).toBe(200);

    // Both super_admin and finance (billing.manage holders) received in-app notice & email; support did NOT
    const noticeType = `manual_payment_submitted_${checkout.sessionId}`;
    expect(await db.notifications.findFirst({ where: { user_id: superAdmin.id, type: noticeType } })).toBeTruthy();
    expect(await db.notifications.findFirst({ where: { user_id: financeAdmin.id, type: noticeType } })).toBeTruthy();
    expect(await db.notifications.findFirst({ where: { user_id: supportStaff.id, type: noticeType } })).toBeNull();

    const adminEmails = mockSendSystemMail.mock.calls.map((c) => c[0].to);
    expect(adminEmails).toContain(superAdmin.email);
    expect(adminEmails).toContain(financeAdmin.email);
    expect(adminEmails).not.toContain(supportStaff.email);
  });

  it("sends idempotent 7d, 3d, 1d, and expired paid renewal reminders to verified emails only and unblocks on renewal", async () => {
    const admin = await configureManualPayment();
    await seedPlan({ id: uid("free-plan"), slug: "free", name: "Free", monthly_price: 0, yearly_price: 0 });
    const proPlan = await seedPlan({ slug: `pro-rem-${seq}`, name: "Pro", monthly_price: 49 });

    const verifiedUser = await seedUser({
      plan: proPlan.slug,
      plan_id: proPlan.id,
      email_verified_at: new Date(),
    });
    const unverifiedUser = await seedUser({
      plan: proPlan.slug,
      plan_id: proPlan.id,
      email_verified_at: null,
    });

    const periodEnd = new Date("2026-12-10T12:00:00.000Z");
    const subVerified = await db.subscriptions.create({
      data: {
        user_id: verifiedUser.id,
        plan_id: proPlan.id,
        status: "active",
        current_period_start: new Date("2026-11-10T12:00:00.000Z"),
        current_period_end: periodEnd,
        provider: "manual",
      },
    });
    await db.subscriptions.create({
      data: {
        user_id: unverifiedUser.id,
        plan_id: proPlan.id,
        status: "active",
        current_period_start: new Date("2026-11-10T12:00:00.000Z"),
        current_period_end: periodEnd,
        provider: "manual",
      },
    });

    // 7 days left -> sent once
    const dayMinus7 = new Date("2026-12-03T12:00:00.000Z");
    await sendRenewalReminders(dayMinus7);
    await sendRenewalReminders(dayMinus7);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === verifiedUser.email)).toHaveLength(1);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === unverifiedUser.email)).toHaveLength(0);

    // 3 days left -> sent once
    const dayMinus3 = new Date("2026-12-07T12:00:00.000Z");
    await sendRenewalReminders(dayMinus3);
    await sendRenewalReminders(dayMinus3);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === verifiedUser.email)).toHaveLength(2);

    // 1 day left -> sent once
    const dayMinus1 = new Date("2026-12-09T12:00:00.000Z");
    await sendRenewalReminders(dayMinus1);
    await sendRenewalReminders(dayMinus1);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === verifiedUser.email)).toHaveLength(3);

    // Expired -> lifecycle expires subscription, reverts user to free (blocked), sends expiry notice + email once
    const afterExpiry = new Date("2026-12-11T12:00:00.000Z");
    await processSubscriptionLifecycles(afterExpiry);
    await expireOverdueSubscriptions(afterExpiry);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === verifiedUser.email)).toHaveLength(4);
    expect(mockSendSystemMail.mock.calls.filter((c) => c[0].to === unverifiedUser.email)).toHaveLength(0);

    const expiredUserCheck = await getTrialStatus(verifiedUser.id);
    expect(expiredUserCheck.status).toBe("expired");
    await expect(assertTrialActive(verifiedUser.id)).rejects.toThrow();

    // User renews after expiry and admin approves -> immediately unblocked
    mockSession.mockResolvedValue({ user: verifiedUser });
    const renewCheckout = await checkoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: proPlan.id, interval: "monthly" }),
      })
    );
    const { data: renewData } = await renewCheckout.json();
    await manualSubmitPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: renewData.sessionId,
          method: "bkash",
          transactionId: "RENEWUNBLOCK01",
          senderNumber: "01755443322",
        }),
      })
    );

    mockSession.mockResolvedValue({ user: admin });
    await approveManualPaymentAction(renewData.sessionId);

    const unblockedStatus = await getTrialStatus(verifiedUser.id);
    expect(unblockedStatus.status).toBe("not_applicable");
    await expect(assertTrialActive(verifiedUser.id)).resolves.toMatchObject({ status: "not_applicable" });
    const renewedSub = await db.subscriptions.findUnique({ where: { id: subVerified.id } });
    expect(renewedSub?.status).toBe("active");
  });
});
