import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import {
  evaluateAccountBouncePause,
  recordAccountAuthFailure,
  recordHardBounceAndSuppress,
  resetAccountAuthFailures,
  isPermanentHardBounceSmtpError,
  isSmtpAuthFailureError,
} from "./deliverability-pause";
import { sendSingleRecipientEmail } from "./sending-engine";
import { saveCampaignSequence, sendSingleRecipientFollowup } from "./sequence-service";
import { getAccountAdaptiveLimitSummary } from "./adaptive-limit-service";

const { mockSession, mockSendMail } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockSendMail: vi.fn(),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockSession(),
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

import { POST as resumePost } from "@/app/api/v1/email-accounts/[id]/resume/route";

describe("Task 8 — Auto-Pause on Bad Signals (Hard Bounces & SMTP Auth Failures)", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: "<ok-8@gmail.com>" });
  });

  it("enforces minimum 30-send sample and strictly >2% 7-day hard-bounce threshold", async () => {
    const userId = uid("user-bounce");
    const accA = await db.email_accounts.create({
      data: {
        id: uid("acc-b-a"),
        user_id: userId,
        label: "Bounce A",
        from_email: "a@gmail.com",
        account_type: "free_gmail",
        status: "active",
      },
    });
    const accB = await db.email_accounts.create({
      data: {
        id: uid("acc-b-b"),
        user_id: userId,
        label: "Healthy B",
        from_email: "b@gmail.com",
        account_type: "free_gmail",
        status: "active",
      },
    });

    const now = new Date("2026-11-26T12:00:00.000Z");

    // 10 sends + 2 bounces (20% bounce rate, but sample < 30) -> MUST NOT pause
    for (let i = 0; i < 10; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: accA.id,
          direction: "out",
          kind: "initial",
          status: "sent",
          sent_at: new Date(now.getTime() - 3600_000),
        },
      });
    }
    for (let i = 0; i < 2; i++) {
      await db.campaign_recipients.create({
        data: {
          campaign_id: "c1",
          user_id: userId,
          assigned_account_id: accA.id,
          email: `b-small-${i}@target.com`,
          status: "bounced",
          last_sent_at: new Date(now.getTime() - 1800_000),
        },
      });
    }
    const underSample = await evaluateAccountBouncePause(accA.id, now);
    expect(underSample.paused).toBe(false);
    expect(underSample.totalSends).toBe(12);

    // Reach 50 sends with 1 bounce = 2.0% exact -> MUST NOT pause (strictly > 2%)
    const accBoundary = await db.email_accounts.create({
      data: {
        id: uid("acc-b-exact"),
        user_id: userId,
        label: "Exact 2%",
        from_email: "exact@gmail.com",
        status: "active",
      },
    });
    const exactRecId = uid("rec-exact-1");
    for (let i = 0; i < 50; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: accBoundary.id,
          recipient_id: i === 0 ? exactRecId : undefined,
          direction: "out",
          kind: "initial",
          status: "sent",
          sent_at: new Date(now.getTime() - 3600_000),
        },
      });
    }
    await db.campaign_recipients.create({
      data: {
        id: exactRecId,
        campaign_id: "c-exact",
        user_id: userId,
        assigned_account_id: accBoundary.id,
        email: "one@target.com",
        status: "bounced",
        last_sent_at: new Date(now.getTime() - 1800_000),
      },
    });
    const exactEval = await evaluateAccountBouncePause(accBoundary.id, now);
    expect(exactEval.paused).toBe(false);
    expect(exactEval.bounceRate).toBe(0.02);

    // Push accA to 32 sends with 2 bounces (>2% and >=30 sample) -> pauses ONLY accA
    for (let i = 0; i < 20; i++) {
      await db.email_messages.create({
        data: {
          user_id: userId,
          email_account_id: accA.id,
          direction: "out",
          kind: "initial",
          status: "sent",
          sent_at: new Date(now.getTime() - 3600_000),
        },
      });
    }
    const pausedEval = await evaluateAccountBouncePause(accA.id, now);
    expect(pausedEval.paused).toBe(true);
    expect(pausedEval.reason).toContain("hard-bounce rate");

    const updatedA = await db.email_accounts.findUnique({ where: { id: accA.id } });
    const untouchedB = await db.email_accounts.findUnique({ where: { id: accB.id } });
    expect(updatedA?.status).toBe("paused_deliverability");
    expect(updatedA?.health_status).toBe("paused");
    expect(untouchedB?.status).toBe("active");
  });

  it("tracks 3 consecutive SMTP auth failures (resets on success) and pauses ONLY failing account", async () => {
    const userId = uid("user-auth");
    const accA = await db.email_accounts.create({
      data: {
        id: uid("acc-auth-a"),
        user_id: userId,
        label: "Auth Fail A",
        from_email: "fail-a@gmail.com",
        status: "active",
      },
    });
    const accB = await db.email_accounts.create({
      data: {
        id: uid("acc-auth-b"),
        user_id: userId,
        label: "Healthy B",
        from_email: "ok-b@gmail.com",
        status: "active",
      },
    });

    expect(isSmtpAuthFailureError("Invalid login: 535-5.7.8 Username and Password not accepted")).toBe(true);

    // Failures 1 & 2 keep account active
    const f1 = await recordAccountAuthFailure(accA.id, "535 Authentication failed");
    const f2 = await recordAccountAuthFailure(accA.id, "EAUTH BadCredentials");
    expect(f1.paused).toBe(false);
    expect(f2.paused).toBe(false);
    expect(f2.consecutiveFailures).toBe(2);

    // Success resets consecutive counter back to 0
    await resetAccountAuthFailures(accA.id);
    const resetAcc = await db.email_accounts.findUnique({ where: { id: accA.id } });
    expect(resetAcc?.consecutive_smtp_auth_failures).toBe(0);

    // 3 consecutive auth failures trigger auto-pause ONLY on accA
    await recordAccountAuthFailure(accA.id, "EAUTH #1");
    await recordAccountAuthFailure(accA.id, "EAUTH #2");
    const f3 = await recordAccountAuthFailure(accA.id, "535 BadCredentials #3");
    expect(f3.paused).toBe(true);
    expect(f3.consecutiveFailures).toBe(3);

    const pausedAcc = await db.email_accounts.findUnique({ where: { id: accA.id } });
    const siblingAcc = await db.email_accounts.findUnique({ where: { id: accB.id } });
    expect(pausedAcc?.status).toBe("paused_deliverability");
    expect(pausedAcc?.deliverability_pause_reason).toContain("3 consecutive SMTP authentication failures");
    expect(siblingAcc?.status).toBe("active");
  });

  it("permanently suppresses bounced recipients on synchronous SMTP 550 5.1.1 rejection and ignores Gmail 550 5.4.5", async () => {
    expect(isPermanentHardBounceSmtpError("550 5.1.1 The email account that you tried to reach does not exist")).toBe(true);
    expect(isPermanentHardBounceSmtpError("550-5.4.5 Daily user sending limit exceeded")).toBe(false);
    expect(isPermanentHardBounceSmtpError("535-5.7.8 Authentication failed")).toBe(false);

    const userId = uid("user-sup");
    await db.users.create({
      data: { id: userId, email: `${userId}@gmail.com`, role: "user", plan: "agency", status: "active" },
    });
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-sup"),
        user_id: userId,
        label: "Sup Inbox",
        from_name: "Alex",
        from_email: "alex-sup@gmail.com",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "alex-sup@gmail.com",
        smtp_password_enc: encrypt("secret"),
        daily_limit: 50,
        account_type: "free_gmail",
        status: "active",
      },
    });
    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-sup"),
        user_id: userId,
        name: "Sup Camp",
        subject: "Hi",
        body_template: "Hello",
        status: "running",
      },
    });
    const rec = await db.campaign_recipients.create({
      data: {
        id: uid("rec-sup"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: acc.id,
        email: "DeadBox@Example.org",
        status: "queued",
      },
    });

    mockSendMail.mockRejectedValueOnce(new Error("550 5.1.1 The email account that you tried to reach does not exist"));
    const sendRes = await sendSingleRecipientEmail(rec.id);
    expect(sendRes).toHaveProperty("bounced", true);

    const updatedRec = await db.campaign_recipients.findUnique({ where: { id: rec.id } });
    expect(updatedRec?.status).toBe("bounced");

    const sup = await db.suppressions.findFirst({
      where: { user_id: userId, email: "deadbox@example.org" },
    });
    expect(sup).toBeTruthy();
    expect(sup?.reason).toBe("bounced");

    // Idempotent check
    await recordHardBounceAndSuppress({
      userId,
      accountId: acc.id,
      recipientId: rec.id,
      campaignId: camp.id,
      email: "deadbox@example.org",
    });
    const allSup = await db.suppressions.findMany({ where: { user_id: userId } });
    expect(allSup).toHaveLength(1);
  });

  it("blocks queued sends on paused_deliverability until manually resumed and preserves Task 6 adaptive limits", async () => {
    const userId = uid("user-resume");
    await db.users.create({
      data: { id: userId, email: `${userId}@gmail.com`, role: "user", plan: "agency", status: "active" },
    });
    const acc = await db.email_accounts.create({
      data: {
        id: uid("acc-res"),
        user_id: userId,
        label: "Resumable Inbox",
        from_name: "Alex",
        from_email: "res@gmail.com",
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: "res@gmail.com",
        imap_password_enc: encrypt("secret"),
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "res@gmail.com",
        smtp_password_enc: encrypt("secret"),
        account_type: "free_gmail",
        detected_age_days: 100,
        start_limit_snapshot: 30,
        current_daily_limit: 30,
        consecutive_smtp_auth_failures: 3,
        deliverability_pause_reason: "Paused after 3 consecutive SMTP auth failures",
        deliverability_paused_at: new Date(),
        health_status: "paused",
        status: "paused_deliverability",
      },
    });

    const pausedSummary = await getAccountAdaptiveLimitSummary(acc);
    expect(pausedSummary.healthStatus).toBe("paused");

    const camp = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-res"),
        user_id: userId,
        name: "Resume Campaign",
        subject: "Hey",
        body_template: "Hi",
        status: "running",
      },
    });
    await saveCampaignSequence(userId, camp.id, "Follow-up Sequence", [
      { step_no: 1, delay_days: 2, mode: "custom", subject_template: "Re: Hey", body_template: "Followup" },
    ]);

    const fuRec = await db.campaign_recipients.create({
      data: {
        id: uid("rec-fu-res"),
        campaign_id: camp.id,
        user_id: userId,
        assigned_account_id: acc.id,
        email: "prospect@acme.io",
        status: "sent",
        current_step: 0,
        last_sent_at: new Date(Date.now() - 3 * 86400_000),
        next_followup_at: new Date(Date.now() - 3600_000),
      },
    });

    // Follow-up job must throttle cleanly without auto-unpausing or failing lead
    const fuRes = await sendSingleRecipientFollowup(fuRec.id);
    expect(fuRes).toHaveProperty("throttled", true);
    expect(fuRes).toHaveProperty("pausedDeliverability", true);
    expect(mockSendMail).not.toHaveBeenCalled();

    // Non-owner cannot resume (404), owner manual resume works via POST /resume
    mockSession.mockResolvedValue({ user: { id: "someone-else", role: "user" } });
    const reqOther = new NextRequest(`http://localhost/api/v1/email-accounts/${acc.id}/resume`, { method: "POST" });
    const resOther = await resumePost(reqOther, { params: Promise.resolve({ id: acc.id }) });
    expect(resOther.status).toBe(404);

    mockSession.mockResolvedValue({ user: { id: userId, role: "user" } });
    const reqOwner = new NextRequest(`http://localhost/api/v1/email-accounts/${acc.id}/resume`, { method: "POST" });
    const resOwner = await resumePost(reqOwner, { params: Promise.resolve({ id: acc.id }) });
    expect(resOwner.status).toBe(200);
    const jsonOwner = await resOwner.json();
    expect(jsonOwner.data.status).toBe("active");
    expect(jsonOwner.data.consecutive_smtp_auth_failures).toBe(0);
    expect(jsonOwner.data.deliverability_pause_reason).toBeNull();
    expect(jsonOwner.data.health_status).toBe("holding");

    const resumedAcc = await db.email_accounts.findUnique({ where: { id: acc.id } });
    const postResumeSummary = await getAccountAdaptiveLimitSummary(resumedAcc);
    expect(postResumeSummary.healthStatus).toBe("holding");
    expect(postResumeSummary.baseAdaptiveLimit).toBe(30); // Did not inflate cap on manual resume
  });
});
