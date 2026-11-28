import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { hashPassword } from "@/server/auth/password";

const {
  mockSession,
  mockCreateSession,
  mockSendSystemMail,
  mockSendMail,
  mockQueueEmailSend,
  mockQueueEmailDispatch,
  mockQueueLeadSearch,
  mockExchangeGoogleCode,
  mockVerifyOAuthState,
  mockGetConfig,
} = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSendSystemMail: vi.fn(),
  mockSendMail: vi.fn(),
  mockQueueEmailSend: vi.fn(),
  mockQueueEmailDispatch: vi.fn(),
  mockQueueLeadSearch: vi.fn(),
  mockExchangeGoogleCode: vi.fn(),
  mockVerifyOAuthState: vi.fn(),
  mockGetConfig: vi.fn(),
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

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: (...args: any[]) => mockSendMail(...args),
    }),
  },
}));

vi.mock("@/server/email/system-mailer", () => ({
  sendSystemMail: (...args: any[]) => mockSendSystemMail(...args),
}));

vi.mock("@/server/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queues")>();
  return {
    ...actual,
    queueEmailSend: (...args: any[]) => mockQueueEmailSend(...args),
    queueEmailDispatch: (...args: any[]) => mockQueueEmailDispatch(...args),
    queueLeadSearch: (...args: any[]) => mockQueueLeadSearch(...args),
  };
});

vi.mock("@/server/integrations/google-sheets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/integrations/google-sheets")>();
  return {
    ...actual,
    exchangeGoogleCode: (...args: any[]) => mockExchangeGoogleCode(...args),
  };
});

vi.mock("@/server/auth/oauth-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/oauth-state")>();
  return {
    ...actual,
    verifyOAuthState: (...args: any[]) => mockVerifyOAuthState(...args),
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockSession(),
    createSession: (...args: any[]) => mockCreateSession(...args),
  };
});

vi.mock("@/server/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/config")>();
  return {
    ...actual,
    getConfig: (...args: any[]) => mockGetConfig(...args),
    getRegistrationMode: async () => "open",
    getAppUrl: async () => "http://localhost:3000",
  };
});

import {
  assertTrialActive,
  backfillFreeUserTrials,
  getConfiguredTrialDays,
  getTrialStatus,
  processTrialReminders,
  startFreeTrialForUser,
  TrialExpiredError,
} from "@/server/billing/trial";
import { signupAction } from "@/server/auth/actions";
import { GET as googleAuthCallbackGET } from "@/app/api/v1/auth/google/callback/route";
import { GET as leadsGET } from "@/app/api/v1/leads/route";
import { POST as leadsSearchPOST } from "@/app/api/v1/leads/search/route";
import { GET as gdprExportGET } from "@/app/api/v1/account/export/route";
import {
  GET as campaignsGET,
  POST as campaignsPOST,
} from "@/app/api/v1/outreach/campaigns/route";
import { PATCH as campaignPATCH } from "@/app/api/v1/outreach/campaigns/[id]/route";
import { POST as socialPublishPOST } from "@/app/api/v1/social/posts/[id]/publish/route";
import { POST as emailAccountsPOST } from "@/app/api/v1/email-accounts/route";
import { POST as billingCheckoutPOST } from "@/app/api/v1/billing/checkout/route";
import { dispatchRunningCampaigns, sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { sendSingleRecipientFollowup } from "@/server/email/sequence-service";
import { createEmailAccount } from "@/server/email/account-service";
import { extendUserTrialAction, setUserTrialExemptAction } from "@/server/admin/user-actions";

describe("14-Day Free Trial (Item 10 comprehensive suite)", () => {
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

  const configOverrides = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    configOverrides.clear();
    mockGetConfig.mockImplementation(async (key: string) => {
      if (configOverrides.has(key)) return configOverrides.get(key) ?? null;
      if (key === "TRIAL_DAYS") return "14";
      if (key === "DEFAULT_PLAN") return "free";
      return null;
    });
    mockSendSystemMail.mockResolvedValue({ ok: true });
    mockSendMail.mockResolvedValue({ messageId: "<sent@test.io>" });
    mockQueueEmailSend.mockResolvedValue(true);
    mockQueueEmailDispatch.mockResolvedValue(true);
    mockQueueLeadSearch.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue("sess-test");
  });

  async function ensureSeedAdmin() {
    const adminId = uid("seed-admin");
    await db.users.create({
      data: {
        id: adminId,
        email: `${adminId}@test.io`,
        name: "Seed Admin",
        password_hash: await hashPassword("StrongPass123!"),
        role: "admin",
        status: "active",
        plan: "enterprise",
        email_verified_at: new Date(),
      },
    });
    return adminId;
  }

  async function createExpiredFreeUser() {
    const userId = uid("expired-free");
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@test.io`,
        name: "Expired Trial User",
        role: "user",
        status: "active",
        plan: "free",
        email_verified_at: new Date(),
      },
    });
    const pastStart = new Date(Date.now() - 20 * 86_400_000);
    await startFreeTrialForUser(userId, { now: pastStart, trialDays: 14 });
    return userId;
  }

  it("provisions a 14-day active trial on email signup and Google OAuth signup", async () => {
    await ensureSeedAdmin();

    // 1. Email signup
    const email = `${uid("email-signup")}@company.io`;
    const formData = new FormData();
    formData.set("name", "Email Trial User");
    formData.set("email", email);
    formData.set("password", "StrongPass123!");
    formData.set("acceptTerms", "on");

    await expect(signupAction(undefined, formData)).rejects.toThrow("NEXT_REDIRECT:/verify-email");

    const emailUser = await db.users.findUnique({ where: { email } });
    expect(emailUser).toBeTruthy();
    const emailTrial = await getTrialStatus(emailUser!.id);
    expect(emailTrial.status).toBe("active");
    expect(emailTrial.daysLeft).toBe(14);
    expect(emailTrial.endsAt).toBeTruthy();

    // 2. Google OAuth signup
    const googleEmail = `${uid("google-signup")}@company.io`;
    mockVerifyOAuthState.mockReturnValue({
      valid: true,
      mode: "login",
      returnTo: "/app",
    });
    mockExchangeGoogleCode.mockResolvedValue({
      email: googleEmail,
      name: "Google Trial User",
      access_token: "tok",
    });

    const req = new NextRequest(
      "http://localhost:3000/api/v1/auth/google/callback?code=auth-code&state=ok",
      { headers: { cookie: "leadreach_oauth_state=nonce123" } }
    );
    const res = await googleAuthCallbackGET(req);
    expect(res.status).toBe(307);

    const googleUser = await db.users.findUnique({ where: { email: googleEmail } });
    expect(googleUser).toBeTruthy();
    const googleTrial = await getTrialStatus(googleUser!.id);
    expect(googleTrial.status).toBe("active");
    expect(googleTrial.daysLeft).toBe(14);
  });

  it("respects TRIAL_DAYS=0 as immediate no-trial rather than falling back to 14", async () => {
    configOverrides.set("TRIAL_DAYS", "0");
    expect(await getConfiguredTrialDays()).toBe(0);

    const userId = uid("zero-trial-user");
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

    await startFreeTrialForUser(userId);
    const status = await getTrialStatus(userId);
    expect(status.trialDaysConfigured).toBe(0);
    expect(status.status).toBe("expired");
    expect(status.daysLeft).toBe(0);
  });

  it("blocks sending, campaign launch/resume, lead search, social publish & inbox creation with trial_expired while keeping reads/exports/billing allowed", async () => {
    const userId = await createExpiredFreeUser();
    const expiredCheck = await getTrialStatus(userId);
    expect(expiredCheck.status).toBe("expired");
    await expect(assertTrialActive(userId)).rejects.toBeInstanceOf(TrialExpiredError);

    mockSession.mockResolvedValue({
      user: {
        id: userId,
        email: `${userId}@test.io`,
        role: "user",
        email_verified_at: new Date(),
      },
    });

    // Lead search blocked with 402 trial_expired
    const searchRes = await leadsSearchPOST(
      new NextRequest("http://localhost:3000/api/v1/leads/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "google_maps",
          keyword: "dentist",
          location: "Austin",
          max_results: 5,
        }),
      })
    );
    expect(searchRes.status).toBe(402);
    expect((await searchRes.json()).code).toBe("trial_expired");

    // Campaign launch blocked with 402 trial_expired
    const acc = await createEmailAccount(userId, {
      label: "Sender",
      from_name: "Expired User",
      from_email: `${userId}@sender.io`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: `${userId}@sender.io`,
      smtp_password: "secret",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });
    const launchRes = await campaignsPOST(
      new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Expired Launch",
          mode: "custom",
          senderAccountIds: [acc.id],
          recipientSource: "manual",
          subjectTemplate: "Hi",
          bodyTemplate: "Body",
          timezone: "UTC",
          launchNow: true,
          recipients: [{ email: "prospect@example.com", name: "Prospect" }],
        }),
      })
    );
    expect(launchRes.status).toBe(402);
    expect((await launchRes.json()).code).toBe("trial_expired");

    // Campaign resume (PATCH -> running) blocked with 402 trial_expired
    const pausedCamp = await db.outreach_campaigns.create({
      data: {
        id: uid("paused-camp"),
        user_id: userId,
        name: "Paused Campaign",
        status: "paused",
        subject_template: "Hi",
        body_template: "Body",
      },
    });
    const resumeRes = await campaignPATCH(
      new NextRequest(`http://localhost:3000/api/v1/outreach/campaigns/${pausedCamp.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
      { params: Promise.resolve({ id: pausedCamp.id }) }
    );
    expect(resumeRes.status).toBe(402);
    expect((await resumeRes.json()).code).toBe("trial_expired");

    // Running campaign email dispatch & single send / follow-up blocked when trial expires
    const runningCamp = await db.outreach_campaigns.create({
      data: {
        id: uid("run-camp"),
        user_id: userId,
        name: "Previously Running Campaign",
        status: "running",
        subject_template: "Hi",
        body_template: "Body",
      },
    });
    const rec = await db.campaign_recipients.create({
      data: {
        id: uid("rec"),
        campaign_id: runningCamp.id,
        user_id: userId,
        assigned_account_id: acc.id,
        email: "target@example.com",
        status: "queued",
      },
    });
    const recFu = await db.campaign_recipients.create({
      data: {
        id: uid("rec-fu"),
        campaign_id: runningCamp.id,
        user_id: userId,
        assigned_account_id: acc.id,
        email: "target-fu@example.com",
        status: "sent",
        current_step: 0,
        next_followup_at: new Date(Date.now() - 60_000),
      },
    });
    const sendRes = await sendSingleRecipientEmail(rec.id);
    expect(sendRes).toMatchObject({ throttled: true, trialExpired: true });
    const fuRes = await sendSingleRecipientFollowup(recFu.id);
    expect(fuRes).toMatchObject({ throttled: true, trialExpired: true });
    await dispatchRunningCampaigns(new Date());
    expect(mockQueueEmailSend).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();

    // Social publish blocked with 402 trial_expired
    const socialRes = await socialPublishPOST(
      new NextRequest("http://localhost:3000/api/v1/social/posts/post-1/publish", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "post-1" }) }
    );
    expect(socialRes.status).toBe(402);
    expect((await socialRes.json()).code).toBe("trial_expired");

    // Creating a new email account blocked with 402 trial_expired
    const emailAccRes = await emailAccountsPOST(
      new NextRequest("http://localhost:3000/api/v1/email-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_email: "new@domain.com",
          smtp_host: "smtp.domain.com",
          smtp_port: 465,
          smtp_security: "ssl",
          smtp_password: "secret",
        }),
      })
    );
    expect(emailAccRes.status).toBe(402);
    expect((await emailAccRes.json()).code).toBe("trial_expired");

    // Reads, GDPR export, and billing checkout STAY ALLOWED
    const readsLeads = await leadsGET(new NextRequest("http://localhost:3000/api/v1/leads"));
    expect(readsLeads.status).toBe(200);
    const readsCampaigns = await campaignsGET();
    expect(readsCampaigns.status).toBe(200);
    const exportRes = await gdprExportGET();
    expect(exportRes.status).toBe(200);

    const paidPlan = await db.plans.create({
      data: {
        id: uid("plan-starter"),
        name: "Starter",
        slug: "starter",
        monthly_price: 19,
        yearly_price: 190,
        currency: "USD",
        is_active: true,
        monthly_leads: 500,
        monthly_social_posts: 60,
        monthly_outreach_emails: 500,
        max_social_accounts: 3,
        max_email_accounts: 2,
        max_campaigns: 10,
      },
    });
    const checkoutRes = await billingCheckoutPOST(
      new NextRequest("http://localhost:3000/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: paidPlan.id, interval: "monthly" }),
      })
    );
    expect(checkoutRes.status).toBe(200);
  });

  it("blocks unverified users from lead search and campaign API routes with 403", async () => {
    const userId = uid("unverified-user");
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@test.io`,
        role: "user",
        status: "active",
        plan: "free",
        email_verified_at: null,
      },
    });
    mockSession.mockResolvedValue({
      user: { id: userId, email: `${userId}@test.io`, role: "user", email_verified_at: null },
    });

    const leadRes = await leadsSearchPOST(
      new NextRequest("http://localhost:3000/api/v1/leads/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "google_maps", keyword: "cafe", location: "NYC", max_results: 5 }),
      })
    );
    expect(leadRes.status).toBe(403);
    expect((await leadRes.json()).code).toBe("EMAIL_NOT_VERIFIED");

    const campRes = await campaignsPOST(
      new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      })
    );
    expect(campRes.status).toBe(403);
    expect((await campRes.json()).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("never blocks paid users or staff/admin roles even with old trial dates", async () => {
    const paidUserId = uid("paid-user");
    const staffUserId = uid("staff-user");

    await db.users.create({
      data: { id: paidUserId, email: `${paidUserId}@test.io`, role: "user", status: "active", plan: "pro" },
    });
    await db.users.create({
      data: { id: staffUserId, email: `${staffUserId}@test.io`, role: "support", status: "active", plan: "free" },
    });

    const paidStatus = await getTrialStatus(paidUserId);
    const staffStatus = await getTrialStatus(staffUserId);
    expect(paidStatus.status).toBe("not_applicable");
    expect(staffStatus.status).toBe("not_applicable");
    await expect(assertTrialActive(paidUserId)).resolves.toMatchObject({ status: "not_applicable" });
    await expect(assertTrialActive(staffUserId)).resolves.toMatchObject({ status: "not_applicable" });
  });

  it("sends reminder emails idempotently at 4d, 1d, and expired ONLY to verified email owners", async () => {
    const verifiedId = uid("rem-verified");
    const unverifiedId = uid("rem-unverified");
    const baseStart = new Date("2026-11-01T12:00:00.000Z");

    await db.users.create({
      data: {
        id: verifiedId,
        email: `${verifiedId}@test.io`,
        name: "Verified Owner",
        role: "user",
        status: "active",
        plan: "free",
        email_verified_at: new Date(),
      },
    });
    await db.users.create({
      data: {
        id: unverifiedId,
        email: `${unverifiedId}@test.io`,
        name: "Unverified Owner",
        role: "user",
        status: "active",
        plan: "free",
        email_verified_at: null,
      },
    });

    await startFreeTrialForUser(verifiedId, { now: baseStart, trialDays: 14 });
    await startFreeTrialForUser(unverifiedId, { now: baseStart, trialDays: 14 });

    // Ends 2026-11-15T12:00:00Z
    // Day 10 (4 days left)
    const day10 = new Date("2026-11-11T12:00:00.000Z");
    await processTrialReminders(day10);
    await processTrialReminders(day10); // Second run must be idempotent
    const calls4d = mockSendSystemMail.mock.calls.filter((c) => c[0].to === `${verifiedId}@test.io`);
    expect(calls4d).toHaveLength(1);
    expect(calls4d[0][0].subject).toContain("4 days");

    // Unverified user must NEVER receive reminder emails
    expect(
      mockSendSystemMail.mock.calls.filter((c) => c[0].to === `${unverifiedId}@test.io`)
    ).toHaveLength(0);

    // Day 13 (1 day left)
    const day13 = new Date("2026-11-14T12:00:00.000Z");
    await processTrialReminders(day13);
    await processTrialReminders(day13);
    const calls1d = mockSendSystemMail.mock.calls.filter((c) => c[0].to === `${verifiedId}@test.io`);
    expect(calls1d).toHaveLength(2);
    expect(calls1d[1][0].subject).toContain("1 day");

    // Day 15 (expired) — also test resilience if mailer fails on one run
    mockSendSystemMail.mockResolvedValueOnce({ ok: false, error: "Temporary SMTP failure" });
    const day15 = new Date("2026-11-16T12:00:00.000Z");
    await expect(processTrialReminders(day15)).resolves.toMatchObject({ processed: expect.any(Number) });
    // Retry after SMTP recovers succeeds and records idempotency marker
    await processTrialReminders(day15);
    await processTrialReminders(day15);
    const callsAll = mockSendSystemMail.mock.calls.filter((c) => c[0].to === `${verifiedId}@test.io`);
    // Initial 4d + 1d + failed attempt + recovered expired = 4 attempts total, no duplicate after marker saved
    expect(callsAll).toHaveLength(4);
    expect(
      mockSendSystemMail.mock.calls.filter((c) => c[0].to === `${unverifiedId}@test.io`)
    ).toHaveLength(0);
  });

  it("backfills existing free users idempotently without touching paid users, staff, or exempt users", async () => {
    const freeBackfillId = uid("bf-free");
    const paidBackfillId = uid("bf-paid");
    const staffBackfillId = uid("bf-staff");
    const exemptBackfillId = uid("bf-exempt");

    await db.users.create({
      data: { id: freeBackfillId, email: `${freeBackfillId}@test.io`, role: "user", status: "active", plan: "free" },
    });
    await db.users.create({
      data: { id: paidBackfillId, email: `${paidBackfillId}@test.io`, role: "user", status: "active", plan: "pro" },
    });
    await db.users.create({
      data: { id: staffBackfillId, email: `${staffBackfillId}@test.io`, role: "admin", status: "active", plan: "free" },
    });
    await db.users.create({
      data: {
        id: exemptBackfillId,
        email: `${exemptBackfillId}@test.io`,
        role: "user",
        status: "active",
        plan: "free",
        trial_exempt: true,
      },
    });

    const deployNow = new Date("2026-11-28T00:00:00.000Z");
    const first = await backfillFreeUserTrials(deployNow);
    expect(first.createdCount).toBeGreaterThanOrEqual(1);

    const bfSub = await db.subscriptions.findFirst({ where: { user_id: freeBackfillId } });
    expect(bfSub).toBeTruthy();
    expect(bfSub?.status).toBe("trialing");
    expect(new Date(bfSub!.current_period_end).getTime()).toBe(
      deployNow.getTime() + 14 * 86_400_000
    );

    // Paid, staff, and exempt must not have been assigned trial subscriptions
    expect(await db.subscriptions.findFirst({ where: { user_id: paidBackfillId, provider: "trial" } })).toBeNull();
    expect(await db.subscriptions.findFirst({ where: { user_id: staffBackfillId, provider: "trial" } })).toBeNull();
    expect(await db.subscriptions.findFirst({ where: { user_id: exemptBackfillId, provider: "trial" } })).toBeNull();

    // Idempotent second run creates nothing more
    const second = await backfillFreeUserTrials(deployNow);
    expect(second.createdCount).toBe(0);
  });

  it("allows admins to extend a user's trial or mark them trial-exempt with audit log entries", async () => {
    const adminId = await ensureSeedAdmin();
    const expiredId = await createExpiredFreeUser();

    mockSession.mockResolvedValue({
      user: { id: adminId, email: `${adminId}@test.io`, role: "admin" },
    });

    expect((await getTrialStatus(expiredId)).status).toBe("expired");

    const ext = await extendUserTrialAction(expiredId, 10);
    expect(ext.ok).toBe(true);
    const activeAgain = await getTrialStatus(expiredId);
    expect(activeAgain.status).toBe("active");
    expect(activeAgain.daysLeft).toBeGreaterThanOrEqual(9);

    const exemptRes = await setUserTrialExemptAction(expiredId, true);
    expect(exemptRes.ok).toBe(true);
    expect((await getTrialStatus(expiredId)).status).toBe("not_applicable");

    const logs = await db.admin_audit_logs.findMany({ where: { target_id: expiredId } });
    const actions = logs.map((l: any) => l.action);
    expect(actions).toContain("user.trial_extend");
    expect(actions).toContain("user.trial_exempt_change");
  });
});
