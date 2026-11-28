import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { assertTrialActive, getTrialStatus, startFreeTrialForUser, TrialExpiredError } from "@/server/billing/trial";
import { recordManualPaymentAction } from "@/app/admin/billing/billing-actions";

const { mockRequirePermission } = vi.hoisted(() => ({
  mockRequirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/guards")>();
  return {
    ...actual,
    requirePermission: (...args: any[]) => mockRequirePermission(...args),
  };
});

describe("Trial Upgrade Path (Item 6)", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("immediately lifts trial_expired block when an admin approves a manual payment", async () => {
    const adminId = uid("admin-billing");
    const userId = uid("user-trial-upgrade");
    const planId = uid("plan-pro");

    await db.users.create({
      data: {
        id: adminId,
        email: `${adminId}@test.io`,
        role: "admin",
        status: "active",
        plan: "enterprise",
      },
    });

    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@test.io`,
        role: "user",
        status: "active",
        plan: "free",
        email_verified_at: new Date(),
      },
    });

    await db.plans.create({
      data: {
        id: planId,
        name: "Pro Plan",
        slug: "pro",
        monthly_price: 49,
        yearly_price: 470,
        currency: "USD",
        is_active: true,
        monthly_leads: 2500,
        monthly_social_posts: 120,
        monthly_outreach_emails: 2500,
        max_social_accounts: 5,
        max_email_accounts: 5,
        max_campaigns: 20,
      },
    });

    // Provision a trial that expired 2 days ago
    const startedAt = new Date(Date.now() - 16 * 86_400_000);
    const sub = await startFreeTrialForUser(userId, { now: startedAt, trialDays: 14 });
    expect(sub).toBeTruthy();

    const expiredStatus = await getTrialStatus(userId);
    expect(expiredStatus.status).toBe("expired");
    await expect(assertTrialActive(userId)).rejects.toBeInstanceOf(TrialExpiredError);

    // Admin records/approves manual payment for Pro plan
    mockRequirePermission.mockResolvedValue({
      id: adminId,
      email: `${adminId}@test.io`,
      role: "admin",
    });

    const result = await recordManualPaymentAction({
      userId,
      planId,
      amount: 49,
      currency: "USD",
      method: "bank_transfer",
      transactionId: `trx_${Date.now()}`,
      durationMonths: 1,
      note: "Verified wire transfer",
    });

    expect(result.success).toBe(true);

    // Immediately after approval (with no process restart or cache clear), trial rule stops applying
    const postUpgradeStatus = await getTrialStatus(userId);
    expect(postUpgradeStatus.status).toBe("not_applicable");
    await expect(assertTrialActive(userId)).resolves.toMatchObject({
      status: "not_applicable",
    });

    const updatedUser = await db.users.findUnique({ where: { id: userId } });
    expect(updatedUser?.plan).toBe("pro");

    const updatedSub = await db.subscriptions.findFirst({ where: { user_id: userId } });
    expect(updatedSub?.status).toBe("active");
    expect(updatedSub?.plan_id).toBe(planId);
  });
});
