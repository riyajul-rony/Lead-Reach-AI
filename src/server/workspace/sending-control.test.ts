import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import {
  sendSingleRecipientEmail,
  dispatchRunningCampaigns,
} from "@/server/email/sending-engine";
import {
  saveCampaignSequence,
  sendSingleRecipientFollowup,
  dispatchDueFollowups,
} from "@/server/email/sequence-service";
import { runSelfWarmupTick } from "@/server/email/warmup-pool-service";
import { exportUserAccountData } from "@/server/account/gdpr-service";

const { mockSession, mockSendMail, mockQueueEmailSend } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockSendMail: vi.fn(),
  mockQueueEmailSend: vi.fn(),
}));

vi.mock("@/server/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queues")>();
  return {
    ...actual,
    queueEmailSend: (...args: any[]) => mockQueueEmailSend(...args),
  };
});

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

import { GET as adminWorkspacesGet } from "@/app/api/v1/admin/workspaces/route";
import { POST as adminPausePost } from "@/app/api/v1/admin/workspaces/[id]/pause/route";
import { POST as adminResumePost } from "@/app/api/v1/admin/workspaces/[id]/resume/route";
import { POST as campaignsPost } from "@/app/api/v1/outreach/campaigns/route";
import { PATCH as campaignPatch } from "@/app/api/v1/outreach/campaigns/[id]/route";

describe("Task 9 — Admin Workspace Sending Pause & Audit Controls", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: "<task9@gmail.com>" });
    mockQueueEmailSend.mockResolvedValue(true);
  });

  it("enforces admin RBAC (401/403) and mandatory pause reason validation", async () => {
    const userId = uid("u-rbac-9");
    const ws = await db.workspaces.create({
      data: { id: uid("ws-rbac-9"), user_id: userId, name: "Tenant A" },
    });

    mockSession.mockResolvedValue(null);
    const r401 = await adminWorkspacesGet(new NextRequest("http://localhost/api/v1/admin/workspaces"));
    expect(r401.status).toBe(401);

    mockSession.mockResolvedValue({ user: { id: userId, role: "user" } });
    const r403List = await adminWorkspacesGet(new NextRequest("http://localhost/api/v1/admin/workspaces"));
    expect(r403List.status).toBe(403);

    const r403Pause = await adminPausePost(
      new NextRequest(`http://localhost/api/v1/admin/workspaces/${ws.id}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "Spam" }),
      }),
      { params: Promise.resolve({ id: ws.id }) }
    );
    expect(r403Pause.status).toBe(403);

    const r403Resume = await adminResumePost(
      new NextRequest(`http://localhost/api/v1/admin/workspaces/${ws.id}/resume`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: ws.id }) }
    );
    expect(r403Resume.status).toBe(403);

    // Blank reason -> 400
    mockSession.mockResolvedValue({ user: { id: uid("adm"), role: "admin" } });
    const rBlank = await adminPausePost(
      new NextRequest(`http://localhost/api/v1/admin/workspaces/${ws.id}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "  " }),
      }),
      { params: Promise.resolve({ id: ws.id }) }
    );
    expect(rBlank.status).toBe(400);
  });

  it("blocks campaigns (launch HTTP 423), queued sends, follow-ups, and warm-up without losing jobs, isolates tenants, and resumes cleanly", async () => {
    const adminId = uid("admin-9");
    const userA = uid("user-a-9");
    const userB = uid("user-b-9");

    await db.users.create({
      data: { id: userA, email: `${userA}@acme.io`, name: "Tenant A", role: "user", plan: "agency", status: "active" },
    });
    await db.users.create({
      data: { id: userB, email: `${userB}@acme.io`, name: "Tenant B", role: "user", plan: "agency", status: "active" },
    });

    const wsA = await db.workspaces.create({
      data: { id: uid("ws-a-9"), user_id: userA, name: "Workspace A", is_default: true },
    });
    const wsB = await db.workspaces.create({
      data: { id: uid("ws-b-9"), user_id: userB, name: "Workspace B", is_default: true },
    });
    await db.workspace_legal_acknowledgements.create({
      data: { user_id: userA, workspace_id: wsA.id, terms_version: "2026-11-v1", accepted_at: new Date() },
    });

    const accA1 = await db.email_accounts.create({
      data: {
        id: uid("acc-a1"),
        user_id: userA,
        label: "A1",
        from_name: "Alice",
        from_email: "a1@acme.io",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "a1@acme.io",
        smtp_password_enc: encrypt("pw"),
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: "a1@acme.io",
        imap_password_enc: encrypt("pw"),
        account_type: "free_gmail",
        warmup_enabled: true,
        daily_limit: 50,
        status: "active",
      },
    });
    await db.email_accounts.create({
      data: {
        id: uid("acc-a2"),
        user_id: userA,
        label: "A2",
        from_name: "Bob",
        from_email: "a2@acme.io",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "a2@acme.io",
        smtp_password_enc: encrypt("pw"),
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: "a2@acme.io",
        imap_password_enc: encrypt("pw"),
        account_type: "free_gmail",
        warmup_enabled: true,
        daily_limit: 50,
        status: "active",
      },
    });
    const accB = await db.email_accounts.create({
      data: {
        id: uid("acc-b1"),
        user_id: userB,
        label: "B1",
        from_name: "Charlie",
        from_email: "b1@beta.io",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "tls",
        smtp_username: "b1@beta.io",
        smtp_password_enc: encrypt("pw"),
        account_type: "free_gmail",
        daily_limit: 50,
        status: "active",
      },
    });

    const campA = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-a-9"),
        user_id: userA,
        name: "Campaign A",
        subject: "Hi A",
        body_template: "Body A",
        status: "running",
        send_window: { startHour: 0, endHour: 24 },
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await saveCampaignSequence(userA, campA.id, "Seq A", [
      { step_no: 1, delay_days: 1, mode: "custom", subject_template: "Re: Hi", body_template: "Followup A" },
    ]);

    const recAQueued = await db.campaign_recipients.create({
      data: {
        id: uid("rec-a-q"),
        campaign_id: campA.id,
        user_id: userA,
        assigned_account_id: accA1.id,
        email: "lead-a@target.com",
        status: "queued",
      },
    });
    const recAFollowup = await db.campaign_recipients.create({
      data: {
        id: uid("rec-a-fu"),
        campaign_id: campA.id,
        user_id: userA,
        assigned_account_id: accA1.id,
        email: "lead-fu@target.com",
        status: "sent",
        current_step: 0,
        last_sent_at: new Date(Date.now() - 10 * 86400_000),
        next_followup_at: new Date(Date.now() - 5 * 86400_000), // Old enough to trigger stale guard unless workspace-paused
      },
    });

    const campB = await db.outreach_campaigns.create({
      data: {
        id: uid("camp-b-9"),
        user_id: userB,
        name: "Campaign B",
        subject: "Hi B",
        body_template: "Body B",
        status: "running",
      },
    });
    const recBQueued = await db.campaign_recipients.create({
      data: {
        id: uid("rec-b-q"),
        campaign_id: campB.id,
        user_id: userB,
        assigned_account_id: accB.id,
        email: "lead-b@target.com",
        status: "queued",
      },
    });

    // Admin pauses Workspace A
    mockSession.mockResolvedValue({ user: { id: adminId, role: "admin" } });
    const pauseRes = await adminPausePost(
      new NextRequest(`http://localhost/api/v1/admin/workspaces/${wsA.id}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "Compliance review" }),
      }),
      { params: Promise.resolve({ id: wsA.id }) }
    );
    expect(pauseRes.status).toBe(200);

    // 1. User A cannot launch a new running campaign (423), nor PATCH campaign to running (423)
    mockSession.mockResolvedValue({ user: { id: userA, role: "user", email_verified_at: new Date() } });
    const launchRes = await campaignsPost(
      new NextRequest("http://localhost/api/v1/outreach/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: "Blocked Launch",
          mode: "template",
          recipientSource: "csv",
          senderAccountIds: [accA1.id],
          recipients: [{ email: "x@example.com" }],
          subjectTemplate: "Hello",
          bodyTemplate: "World",
          launchNow: true,
        }),
      })
    );
    expect(launchRes.status).toBe(423);
    const launchJson = await launchRes.json();
    expect(launchJson.code).toBe("WORKSPACE_SENDING_PAUSED");

    const draftCamp = await db.outreach_campaigns.create({
      data: { id: uid("camp-draft-9"), user_id: userA, name: "Draft A", status: "draft" },
    });
    const patchRes = await campaignPatch(
      new NextRequest(`http://localhost/api/v1/outreach/campaigns/${draftCamp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "running" }),
      }),
      { params: Promise.resolve({ id: draftCamp.id }) }
    );
    expect(patchRes.status).toBe(423);

    // 2. Worker single initial send & dispatch loop block Workspace A without modifying queued lead
    const initPaused = await sendSingleRecipientEmail(recAQueued.id);
    expect(initPaused).toHaveProperty("throttled", true);
    expect(initPaused).toHaveProperty("workspacePaused", true);
    const fuPaused = await sendSingleRecipientFollowup(recAFollowup.id);
    expect(fuPaused).toHaveProperty("throttled", true);
    expect(fuPaused).toHaveProperty("workspacePaused", true);
    await dispatchDueFollowups(new Date());
    const fuUnexpired = await db.campaign_recipients.findUnique({ where: { id: recAFollowup.id } });
    expect(fuUnexpired?.status).toBe("sent"); // NOT marked needs_review while paused
    await dispatchRunningCampaigns(new Date());

    // Warm-up tick skips paused Workspace A
    const mockWarmupTransport = vi.fn().mockResolvedValue({ messageId: "<wu@acme.io>" });
    await runSelfWarmupTick(mockWarmupTransport, new Date());
    const warmupSentForA = mockWarmupTransport.mock.calls.filter(
      (c) => c[0]?.account?.user_id === userA
    );
    expect(warmupSentForA).toHaveLength(0);
    expect(mockQueueEmailSend.mock.calls.some((c) => c[0] === recAQueued.id)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();

    // 3. Cross-tenant isolation: Workspace B sends normally!
    const resB = await sendSingleRecipientEmail(recBQueued.id);
    expect(resB).toHaveProperty("success", true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].to).toBe("lead-b@target.com");

    // 4. GDPR export includes pause fields
    const gdprExport = await exportUserAccountData(userA);
    const exportedWs = gdprExport.workspaces[0] as any;
    expect(exportedWs.sending_status).toBe("paused_by_admin");
    expect(exportedWs.pause_reason).toBe("Compliance review");

    // 5. Admin resumes Workspace A -> audit log records both pause & resume; queued recipient now dispatches!
    mockSession.mockResolvedValue({ user: { id: adminId, role: "admin" } });
    const resumeRes = await adminResumePost(
      new NextRequest(`http://localhost/api/v1/admin/workspaces/${wsA.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ reason: "Review passed" }),
      }),
      { params: Promise.resolve({ id: wsA.id }) }
    );
    expect(resumeRes.status).toBe(200);

    const actions = await db.admin_actions.findMany({ where: { workspace_id: wsA.id } });
    expect(actions.map((a: any) => a.action)).toContain("workspace_sending_pause");
    expect(actions.map((a: any) => a.action)).toContain("workspace_sending_resume");

    const resumedSend = await sendSingleRecipientEmail(recAQueued.id);
    expect(resumedSend).toHaveProperty("success", true);

    // Cleanup running test campaigns
    await db.outreach_campaigns.update({ where: { id: campA.id }, data: { status: "paused" } });
    await db.outreach_campaigns.update({ where: { id: campB.id }, data: { status: "paused" } });
  });
});
