import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import {
  detectEmailAccountType,
  detectAccountAgeViaImap,
  runAccountProfileDetection,
  type ImapReadOnlyClientLike,
} from "./account-profile-detector";
import {
  getAccountAgeTier,
  calculateStartLimit,
  computeEffectiveAdaptiveLimit,
  evaluateAccountSevenDayWindow,
  setAdminAccountDailyLimitOverride,
} from "./adaptive-limit-service";
import {
  reserveAccountDailyCapacity,
  releaseAccountDailyCapacity,
  getAccountDailyCapacitySnapshot,
  isGmailDailyLimitError,
  getUtcDayStart,
} from "./daily-capacity";
import { updateEmailAccount } from "./account-service";
import { sendSingleRecipientEmail } from "./sending-engine";
import { exportUserAccountData, deleteOwnAccount } from "@/server/account/gdpr-service";

const { mockGetSessionUser, mockSendMail } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockSendMail: vi.fn(),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockGetSessionUser(),
  };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: (...args: any[]) => mockSendMail(...args),
      close: vi.fn(),
    }),
  },
}));

import { PATCH as adminLimitOverridePatch } from "@/app/api/v1/admin/email-accounts/[id]/limit-override/route";

describe("Task 6 — Adaptive Daily Sending Limits & Profile Detection", () => {
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: "<ok@gmail.com>" });
  });

  it("classifies Free Gmail, Google Workspace (MX), and non-Google/timeout fallback cleanly", async () => {
    const gmail = await detectEmailAccountType({
      email: "Alex@Gmail.com",
      resolveMxFn: vi.fn(),
    });
    expect(gmail.accountType).toBe("free_gmail");
    expect(gmail.isGoogleWorkspace).toBe(false);

    const workspaceTrial = await detectEmailAccountType({
      email: "alex@acme.io",
      resolveMxFn: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
    });
    expect(workspaceTrial.accountType).toBe("workspace_trial");
    expect(workspaceTrial.isGoogleWorkspace).toBe(true);

    const workspacePaid = await detectEmailAccountType({
      email: "alex@acme.io",
      workspaceTier: "paid",
      resolveMxFn: async () => [{ exchange: "smtp.google.com.", priority: 1 }],
    });
    expect(workspacePaid.accountType).toBe("workspace_paid");

    const nonGoogle = await detectEmailAccountType({
      email: "alex@outlook-custom.org",
      workspaceTier: "paid",
      resolveMxFn: async () => [{ exchange: "mx.outlook.com", priority: 10 }],
    });
    expect(nonGoogle.accountType).toBe("workspace_trial");
    expect(nonGoogle.isNonGoogleOrUnknown).toBe(true);

    const dnsFail = await detectEmailAccountType({
      email: "alex@broken.example",
      resolveMxFn: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(dnsFail.accountType).toBe("workspace_trial");
    expect(dnsFail.isNonGoogleOrUnknown).toBe(true);
  });

  it("detects mailbox age read-only via IMAP \\All attribute without reading bodies", async () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const fetchCalls: Array<{ range: string; query: any }> = [];
    let readOnlyArg: boolean | undefined;

    const localizedClient: ImapReadOnlyClientLike = {
      connect: vi.fn(async () => {}),
      list: vi.fn(async () => [
        { path: "INBOX", specialUse: "\\Inbox" },
        { path: "[Gmail]/Tous les messages", specialUse: "\\All" },
      ]),
      getMailboxLock: vi.fn(async (_path, opts) => {
        readOnlyArg = opts?.readOnly;
        return { release: vi.fn() };
      }),
      status: vi.fn(async () => ({ messages: 250 })),
      fetch: async function* (range, query) {
        fetchCalls.push({ range, query });
        yield { seq: 1, internalDate: new Date("2025-11-01T00:00:00.000Z") }; // > 365 days
        yield { seq: 2, internalDate: new Date("2026-01-15T00:00:00.000Z") };
      },
      logout: vi.fn(async () => {}),
    };

    const res = await detectAccountAgeViaImap(
      { host: "imap.gmail.com", port: 993, security: "ssl", username: "a@gmail.com", password: "pw" },
      { now, createClient: () => localizedClient }
    );

    expect(readOnlyArg).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].range).toBe("1:5");
    expect(fetchCalls[0].query).toEqual({ internalDate: true });
    expect(res.ageSource).toBe("imap");
    expect(res.messageCount).toBe(250);
    expect(res.detectedAgeDays).toBeGreaterThanOrEqual(365);

    const emptyClient: ImapReadOnlyClientLike = {
      ...localizedClient,
      status: vi.fn(async () => ({ messages: 2 })),
    };
    const emptyRes = await detectAccountAgeViaImap(
      { host: "imap.gmail.com", username: "new@gmail.com", password: "pw" },
      { now, createClient: () => emptyClient }
    );
    expect(emptyRes.ageSource).toBe("imap");
    expect(emptyRes.detectedAgeDays).toBe(0);
    expect(emptyRes.messageCount).toBe(2);

    const brokenClient: ImapReadOnlyClientLike = {
      ...localizedClient,
      connect: vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    };
    const fallbackRes = await detectAccountAgeViaImap(
      { host: "imap.gmail.com", username: "err@gmail.com", password: "pw" },
      { now, createClient: () => brokenClient }
    );
    expect(fallbackRes.ageSource).toBe("fallback");
    expect(fallbackRes.detectedAgeDays).toBe(0);
    expect(fallbackRes.warning).toBe("Could not verify account age");
  });

  it("enforces exact age-tier boundaries, plan ceilings, and >=14d warm-up bonus", () => {
    expect(getAccountAgeTier(29).tier).toBe("under_30d");
    expect(getAccountAgeTier(30).tier).toBe("30_to_89d");
    expect(getAccountAgeTier(89).tier).toBe("30_to_89d");
    expect(getAccountAgeTier(90).tier).toBe("90_to_364d");
    expect(getAccountAgeTier(364).tier).toBe("90_to_364d");
    expect(getAccountAgeTier(365).tier).toBe("365d_plus");

    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 29, hasWarmupBonus: false })).toBe(10);
    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 30, hasWarmupBonus: false })).toBe(20);
    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 89, hasWarmupBonus: false })).toBe(20);
    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 90, hasWarmupBonus: false })).toBe(30);
    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 364, hasWarmupBonus: false })).toBe(30);
    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 365, hasWarmupBonus: false })).toBe(40);

    expect(calculateStartLimit({ planType: "free_gmail", detectedAgeDays: 365, hasWarmupBonus: true })).toBe(50);
    expect(calculateStartLimit({ planType: "workspace_trial", detectedAgeDays: 400, hasWarmupBonus: true })).toBe(50);
    expect(calculateStartLimit({ planType: "workspace_paid", detectedAgeDays: 400, hasWarmupBonus: true })).toBe(50);

    const paidCalc = computeEffectiveAdaptiveLimit({
      account_type: "workspace_paid",
      from_email: "alex@acme.io",
      detected_age_days: 400,
      healthy_weeks_completed: 6,
    });
    expect(paidCalc.planCeiling).toBe(100);
    expect(paidCalc.effectiveLimit).toBe(100);
  });

  it("progresses weekly ramp cleanly across healthy, low-volume active, neutral hold, unhealthy step-down, and floor 5", async () => {
    const userId = uid("user-ramp");
    await db.users.create({
      data: { id: userId, email: `${userId}@gmail.com`, role: "user", status: "active" },
    });

    const rampStart = new Date("2026-11-01T00:00:00.000Z");
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-ramp"),
        user_id: userId,
        label: "Ramp Inbox",
        from_email: `${userId}@gmail.com`,
        account_type: "free_gmail",
        detected_age_days: 15,
        start_limit_snapshot: 10,
        current_daily_limit: 10,
        daily_limit: 10,
        healthy_weeks_completed: 0,
        ramp_started_at: rampStart,
        status: "active",
        health_status: "healthy",
      },
    });

    // Week 1: Healthy (>=30 sends, 0% bounce) -> +10/day (10 -> 20)
    for (let i = 0; i < 30; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: acc.id,
          direction: "out",
          kind: "initial",
          status: "sent",
          sent_at: new Date("2026-11-03T10:00:00.000Z"),
        },
      });
    }
    const accW1 = await db.email_accounts.findUnique({ where: { id: acc.id } });
    const w1 = await evaluateAccountSevenDayWindow(
      accW1,
      new Date("2026-11-08T01:00:00.000Z")
    );
    expect(w1.evaluated).toBe(true);
    expect(w1.outcome).toBe("healthy");
    expect(w1.oldLimit).toBe(10);
    expect(w1.newLimit).toBe(20);
    const histAfterW1 = await db.account_limit_history.findMany({ where: { account_id: acc.id } });
    expect(histAfterW1).toHaveLength(1);

    // Separate low-volume active inbox: 4 active days at >=50% of 10 (5/day = 20 sends < 30) -> healthy +10
    const accLowVol = await db.email_accounts.create({
      data: {
        id: uid("acc-lv"),
        user_id: userId,
        label: "Low Vol",
        from_email: `lv-${userId}@gmail.com`,
        account_type: "free_gmail",
        detected_age_days: 5,
        start_limit_snapshot: 10,
        current_daily_limit: 10,
        healthy_weeks_completed: 0,
        ramp_started_at: rampStart,
        status: "active",
        health_status: "healthy",
      },
    });
    for (const day of ["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]) {
      for (let i = 0; i < 5; i++) {
        await db.email_messages.create({
          data: {
            user_id: userId,
            email_account_id: accLowVol.id,
            direction: "out",
            kind: "initial",
            status: "sent",
            sent_at: new Date(`${day}T10:00:00.000Z`),
          },
        });
      }
    }
    const lowVolRes = await evaluateAccountSevenDayWindow(
      accLowVol,
      new Date("2026-11-08T01:00:00.000Z")
    );
    expect(lowVolRes.outcome).toBe("healthy");
    expect(lowVolRes.newLimit).toBe(20);

    // Week 2 on main inbox: Neutral hold (1 send) -> keeps 20
    await db.email_messages.create({
      data: {
        user_id: userId,
        email_account_id: acc.id,
        direction: "out",
        kind: "initial",
        status: "sent",
        sent_at: new Date("2026-11-10T10:00:00.000Z"),
      },
    });
    const accW2 = await db.email_accounts.findUnique({ where: { id: acc.id } });
    const w2 = await evaluateAccountSevenDayWindow(
      accW2,
      new Date("2026-11-15T01:00:00.000Z")
    );
    expect(w2.outcome).toBe("hold");
    expect(w2.newLimit).toBe(20);

    // Week 3 on main inbox: >5% hard bounce (2 bounces / 20 sends = 10%) -> step down (20 -> 10)
    for (let i = 0; i < 20; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: acc.id,
          direction: "out",
          kind: "followup",
          status: "sent",
          sent_at: new Date("2026-11-17T10:00:00.000Z"),
        },
      });
    }
    await db.campaign_recipients.create({
      data: {
        campaign_id: "camp-b-1",
        assigned_account_id: acc.id,
        recipient_email: "b1@example.com",
        status: "bounced",
        last_sent_at: new Date("2026-11-17T11:00:00.000Z"),
      },
    });
    await db.campaign_recipients.create({
      data: {
        campaign_id: "camp-b-1",
        assigned_account_id: acc.id,
        recipient_email: "b2@example.com",
        status: "bounced",
        last_sent_at: new Date("2026-11-17T12:00:00.000Z"),
      },
    });
    const accW3 = await db.email_accounts.findUnique({ where: { id: acc.id } });
    const w3 = await evaluateAccountSevenDayWindow(
      accW3,
      new Date("2026-11-22T01:00:00.000Z")
    );
    expect(w3.outcome).toBe("reduced");
    expect(w3.newLimit).toBe(10);

    const floored = computeEffectiveAdaptiveLimit({
      from_email: "alex@gmail.com",
      account_type: "free_gmail",
      start_limit_snapshot: 10,
      healthy_weeks_completed: 0,
      user_daily_limit: 5,
    });
    expect(floored.effectiveLimit).toBe(5);
  });

  it("keeps running start_limit_snapshot stable across forced profile re-detection", async () => {
    const userId = uid("user-recheck");
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-recheck"),
        user_id: userId,
        label: "Acme",
        from_email: "alex@acme.io",
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: "alex@acme.io",
        imap_password_enc: encrypt("app-pass"),
        account_type: "workspace_trial",
        detected_age_days: 10,
        start_limit_snapshot: 10,
        ramp_started_at: new Date("2026-11-01T00:00:00.000Z"),
        status: "active",
      },
    });

    const mockImap: ImapReadOnlyClientLike = {
      connect: vi.fn(async () => {}),
      list: vi.fn(async () => [{ path: "All Mail", specialUse: "\\All" }]),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      status: vi.fn(async () => ({ messages: 500 })),
      fetch: async function* () {
        yield { seq: 1, internalDate: new Date("2025-01-01T00:00:00.000Z") };
      },
      logout: vi.fn(async () => {}),
    };

    const res = await runAccountProfileDetection(acc.id, {
      force: true,
      workspaceTier: "paid",
      resolveMxFn: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
      createImapClient: () => mockImap,
    });

    expect(res.account.account_type).toBe("workspace_paid");
    expect(res.account.age_source).toBe("imap");
    expect(res.account.start_limit_snapshot).toBe(10);
  });

  it("allows user to lower cap (min 5) and blocks user raising above adaptive cap; enforces admin RBAC & audit trail", async () => {
    const userId = uid("user-rbac");
    const adminId = uid("admin-rbac");
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-rbac"),
        user_id: userId,
        label: "RBAC Inbox",
        from_email: "alex@gmail.com",
        account_type: "free_gmail",
        detected_age_days: 100,
        start_limit_snapshot: 30,
        current_daily_limit: 30,
        daily_limit: 30,
        status: "active",
      },
    });

    const lowered = await updateEmailAccount(userId, acc.id, { user_daily_limit: 15 });
    expect(lowered.user_daily_limit).toBe(15);

    await expect(updateEmailAccount(userId, acc.id, { user_daily_limit: 45 })).rejects.toThrow(
      /never higher than the adaptive limit/i
    );

    mockGetSessionUser.mockResolvedValue({ user: { id: userId, role: "user" } });
    const req403 = new NextRequest(`http://localhost/api/v1/admin/email-accounts/${acc.id}/limit-override`, {
      method: "PATCH",
      body: JSON.stringify({ overrideLimit: 120 }),
    });
    const res403 = await adminLimitOverridePatch(req403, { params: Promise.resolve({ id: acc.id }) });
    expect(res403.status).toBe(403);

    mockGetSessionUser.mockResolvedValue({ user: { id: adminId, role: "admin" } });
    const reqAboveMax = new NextRequest(`http://localhost/api/v1/admin/email-accounts/${acc.id}/limit-override`, {
      method: "PATCH",
      body: JSON.stringify({ overrideLimit: 200 }),
    });
    const resAboveMax = await adminLimitOverridePatch(reqAboveMax, { params: Promise.resolve({ id: acc.id }) });
    expect(resAboveMax.status).toBe(400);

    await updateEmailAccount(userId, acc.id, { user_daily_limit: null });
    const overrideRes = await setAdminAccountDailyLimitOverride({
      adminId,
      accountId: acc.id,
      overrideLimit: 120,
      reason: "Verified dedicated warm domain",
    });
    expect(overrideRes.newLimit).toBe(120);

    const actions = await db.admin_actions.findMany({ where: { account_id: acc.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("account_daily_limit_override");
    expect(actions[0].reason).toBe("Verified dedicated warm domain");

    const hist = await db.account_limit_history.findMany({ where: { account_id: acc.id } });
    expect(hist.some((h: any) => h.new_limit === 120)).toBe(true);
  });

  it("enforces atomic concurrency cap, 50% official limit safety invariant with warmup logs, and release on failure", async () => {
    const userId = uid("user-conc");
    const account = await db.email_accounts.create({
      data: {
        id: uid("acc-conc"),
        user_id: userId,
        label: "Conc Inbox",
        from_email: "conc@gmail.com",
        account_type: "free_gmail",
        detected_age_days: 5,
        start_limit_snapshot: 5,
        current_daily_limit: 5,
        user_daily_limit: 5,
        daily_limit: 5,
        status: "active",
      },
    });

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => reserveAccountDailyCapacity(account))
    );
    const allowed = attempts.filter((a) => a.allowed);
    const denied = attempts.filter((a) => !a.allowed);
    expect(allowed).toHaveLength(5);
    expect(denied).toHaveLength(7);

    if (allowed[0].allowed) {
      await releaseAccountDailyCapacity(allowed[0].reservation);
    }
    const afterRelease = await reserveAccountDailyCapacity(account);
    expect(afterRelease.allowed).toBe(true);

    for (const a of allowed.slice(1)) {
      if (a.allowed) await releaseAccountDailyCapacity(a.reservation);
    }
    if (afterRelease.allowed) {
      await releaseAccountDailyCapacity(afterRelease.reservation);
    }

    const acc50 = await db.email_accounts.create({
      data: {
        id: uid("acc-50pct"),
        user_id: userId,
        label: "Safety 50",
        from_email: "safety@gmail.com",
        account_type: "free_gmail",
        admin_daily_limit_override: 100,
        status: "active",
      },
    });
    const todayMid = new Date(getUtcDayStart().getTime() + 3600_000);
    for (let i = 0; i < 246; i++) {
      await db.warmup_logs.create({
        data: {
          from_account_id: acc50.id,
          to_account_id: "peer-1",
          status: "sent",
          sent_at: todayMid,
        },
      });
    }
    const snap = await getAccountDailyCapacitySnapshot(acc50, todayMid);
    expect(snap.safetyMaxCombined).toBe(250);
    expect(snap.warmupSentToday).toBe(246);
    expect(snap.remaining50PctCampaignCap).toBe(4);
    expect(snap.effectiveCampaignDailyCap).toBe(4);
  });

  it("postpones recipient on Gmail 550 5.4.5 rate-limit without failing lead and marks account rate-limited until UTC midnight", async () => {
    expect(isGmailDailyLimitError("550-5.4.5 Daily user sending limit exceeded")).toBe(true);
    expect(isGmailDailyLimitError("454 4.7.0 Too many messages started")).toBe(true);
    expect(isGmailDailyLimitError("550 5.1.1 User unknown")).toBe(false);

    const userId = uid("user-rl");
    await db.users.create({
      data: { id: userId, email: `${userId}@gmail.com`, role: "user", plan: "agency", status: "active" },
    });
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-rl"),
        user_id: userId,
        label: "RL Inbox",
        from_name: "Alex",
        from_email: "rl@gmail.com",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "rl@gmail.com",
        smtp_password_enc: encrypt("secret-app-pw"),
        account_type: "free_gmail",
        detected_age_days: 100,
        start_limit_snapshot: 30,
        daily_limit: 30,
        status: "active",
      },
    });
    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-rl"),
        user_id: userId,
        name: "RL Campaign",
        subject: "Quick question",
        body_template: "Hi there",
        status: "running",
      },
    });
    const rec = await db.campaign_recipients.create({
      data: {
        id: uid("rec-rl"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: acc.id,
        email: "lead@target.com",
        name: "Lead",
        status: "queued",
      },
    });

    mockSendMail.mockRejectedValueOnce(new Error("550-5.4.5 Daily user sending limit exceeded"));
    const sendRes = await sendSingleRecipientEmail(rec.id);
    expect(sendRes).toHaveProperty("throttled", true);

    const updatedRec = await db.campaign_recipients.findUnique({ where: { id: rec.id } });
    expect(updatedRec?.status).toBe("queued");
    expect(updatedRec?.assigned_account_id).toBeNull();
    expect(String(updatedRec?.error || "")).toContain("Provider rate limit reached");

    const updatedAcc = await db.email_accounts.findUnique({ where: { id: acc.id } });
    expect(updatedAcc?.rate_limited_until).toBeTruthy();
    expect(new Date(updatedAcc?.rate_limited_until).getTime()).toBeGreaterThan(Date.now());
    expect(updatedAcc?.health_status).toBe("reduced");
  });

  it("includes account_limit_history and admin_actions in GDPR export and cleans up cleanly on deletion", async () => {
    const userId = uid("user-gdpr-6");
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@gmail.com`,
        name: "GDPR Six",
        role: "user",
        plan: "starter",
        status: "active",
      },
    });
    const hist = await db.account_limit_history.create({
      data: {
        account_id: "acc-g1",
        user_id: userId,
        date: new Date(),
        old_limit: 10,
        new_limit: 20,
        reason: "Healthy 7-day window",
      },
    });
    const admAct = await db.admin_actions.create({
      data: {
        admin_id: "admin-1",
        action: "account_daily_limit_override",
        reason: "Support ticket #101",
        target_user_id: userId,
        account_id: "acc-g1",
      },
    });

    const exported = await exportUserAccountData(userId);
    expect(exported.account_limit_history).toHaveLength(1);

    await deleteOwnAccount(userId, { confirmation: "DELETE" });

    const remainingHist = await db.account_limit_history.findMany({ where: { id: hist.id } });
    expect(remainingHist).toHaveLength(0);

    const retainedAdminAct = await db.admin_actions.findUnique({ where: { id: admAct.id } });
    expect(retainedAdminAct).toBeTruthy();
    expect(retainedAdminAct?.target_user_id).toBeNull();
  });
});
