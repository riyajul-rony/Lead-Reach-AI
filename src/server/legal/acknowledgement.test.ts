import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { createEmailAccount } from "@/server/email/account-service";
import { exportUserAccountData, deleteOwnAccount } from "@/server/account/gdpr-service";
import { signupAction } from "@/server/auth/actions";

const { mockSession } = vi.hoisted(() => ({
  mockSession: vi.fn(),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockSession(),
  };
});

import * as LegalAckRoute from "@/app/api/v1/workspace/legal-acknowledgement/route";
import * as CampaignsRoute from "@/app/api/v1/outreach/campaigns/route";
import * as SingleCampaignRoute from "@/app/api/v1/outreach/campaigns/[id]/route";

describe("Phase 6 Task 5: Legal Terms, Signup Consent & First-Launch Acknowledgement", () => {
  let userId = "99999999-9999-4999-8999-999999999901";
  let idx = 0;
  const prevTermsVersion = process.env.LEGAL_TERMS_VERSION;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.LEGAL_TERMS_VERSION;
    idx++;
    userId = `99999999-9999-4999-8999-99999999990${idx}`;
    await db.users.create({
      data: {
        id: userId,
        email: `legal-${idx}@leadreach.io`,
        name: "Alex Legal",
        password_hash: await hashPassword("StrongPass123!"),
        role: "user",
        status: "active",
        plan: "agency",
      },
    });
    mockSession.mockResolvedValue({
      sessionId: `sess-legal-${idx}`,
      user: {
        id: userId,
        email: `legal-${idx}@leadreach.io`,
        name: "Alex Legal",
        role: "user",
        email_verified_at: new Date(),
      },
    });
  });

  afterEach(() => {
    if (prevTermsVersion === undefined) delete process.env.LEGAL_TERMS_VERSION;
    else process.env.LEGAL_TERMS_VERSION = prevTermsVersion;
  });

  async function setupAccount() {
    return createEmailAccount(userId, {
      label: "Sender",
      from_name: "Alex Legal",
      from_email: `alex-legal-${idx}@agency.com`,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_username: `alex-legal-${idx}@agency.com`,
      smtp_password: "app-password",
      imap_host: "imap.gmail.com",
      imap_port: 993,
    });
  }

  it("blocks direct launch and draft-to-running PATCH with 422 until accepted, then does not re-prompt", async () => {
    const account = await setupAccount();

    // 1. Initial GET -> accepted: false
    const statusRes1 = await LegalAckRoute.GET();
    const statusJson1 = await statusRes1.json();
    expect(statusRes1.status).toBe(200);
    expect(statusJson1.data.accepted).toBe(false);
    expect(statusJson1.data.termsVersion).toBe("2026-11-v1");

    // 2. Direct POST launchNow=true -> 422
    const launchReq = new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "Blocked Launch Campaign",
        mode: "custom",
        senderAccountIds: [account.id],
        recipientSource: "manual",
        subjectTemplate: "Hello",
        bodyTemplate: "Hi {{first_name}}",
        timezone: "UTC",
        launchNow: true,
        recipients: [{ email: "lead1@company.com", name: "Dana" }],
      }),
    });
    const blockedRes = await CampaignsRoute.POST(launchReq);
    const blockedJson = await blockedRes.json();
    expect(blockedRes.status).toBe(422);
    expect(blockedJson.code).toBe("LEGAL_ACKNOWLEDGEMENT_REQUIRED");

    // 3. Draft save succeeds, then PATCH status="running" -> 422
    const draftReq = new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "Draft Campaign",
        mode: "custom",
        senderAccountIds: [account.id],
        recipientSource: "manual",
        subjectTemplate: "Hello",
        bodyTemplate: "Hi {{first_name}}",
        timezone: "UTC",
        launchNow: false,
        recipients: [{ email: "lead2@company.com", name: "Dana" }],
      }),
    });
    const draftRes = await CampaignsRoute.POST(draftReq);
    expect(draftRes.status).toBe(201);
    const draftId = (await draftRes.json()).data.campaign.id;

    const patchBlocked = await SingleCampaignRoute.PATCH(
      new NextRequest(`http://localhost:3000/api/v1/outreach/campaigns/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "running" }),
      }),
      { params: Promise.resolve({ id: draftId }) }
    );
    expect(patchBlocked.status).toBe(422);

    // 4. Attempting POST acknowledgement with accepted=false -> 400
    const badAcceptRes = await LegalAckRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/workspace/legal-acknowledgement", {
        method: "POST",
        body: JSON.stringify({ accepted: false }),
      })
    );
    expect(badAcceptRes.status).toBe(400);

    // 5. Accept acknowledgement -> persists user_id, workspace_id, terms_version, accepted_at
    const acceptRes = await LegalAckRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/workspace/legal-acknowledgement", {
        method: "POST",
        body: JSON.stringify({ accepted: true, termsVersion: "2026-11-v1" }),
      })
    );
    expect(acceptRes.status).toBe(200);
    const acceptJson = await acceptRes.json();
    expect(acceptJson.data.accepted).toBe(true);

    // 6. Status now remains accepted (no repeat modal) & both PATCH and POST launch succeed
    const statusRes2 = await LegalAckRoute.GET();
    expect((await statusRes2.json()).data.accepted).toBe(true);

    const patchAllowed = await SingleCampaignRoute.PATCH(
      new NextRequest(`http://localhost:3000/api/v1/outreach/campaigns/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "running" }),
      }),
      { params: Promise.resolve({ id: draftId }) }
    );
    expect(patchAllowed.status).toBe(200);

    const launchAllowed = await CampaignsRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: "Second Launch Campaign",
          mode: "custom",
          senderAccountIds: [account.id],
          recipientSource: "manual",
          subjectTemplate: "Hello",
          bodyTemplate: "Hi {{first_name}}",
          timezone: "UTC",
          launchNow: true,
          recipients: [{ email: "lead3@company.com", name: "Dana" }],
        }),
      })
    );
    expect(launchAllowed.status).toBe(201);
  });

  it("re-prompts and re-enforces 422 when LEGAL_TERMS_VERSION changes", async () => {
    const account = await setupAccount();

    // Accept v1
    await LegalAckRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/workspace/legal-acknowledgement", {
        method: "POST",
        body: JSON.stringify({ accepted: true }),
      })
    );

    // Bump terms version -> must require acceptance again
    process.env.LEGAL_TERMS_VERSION = "2026-12-v2";

    const statusRes = await LegalAckRoute.GET();
    const statusJson = await statusRes.json();
    expect(statusJson.data.accepted).toBe(false);
    expect(statusJson.data.termsVersion).toBe("2026-12-v2");

    const blockedAfterBump = await CampaignsRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/outreach/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: "Post-Bump Blocked",
          mode: "custom",
          senderAccountIds: [account.id],
          recipientSource: "manual",
          subjectTemplate: "Hello",
          bodyTemplate: "Hi {{first_name}}",
          timezone: "UTC",
          launchNow: true,
          recipients: [{ email: "lead4@company.com", name: "Dana" }],
        }),
      })
    );
    expect(blockedAfterBump.status).toBe(422);
  });

  it("requires accepting Terms of Service and Acceptable Use Policy on signup", async () => {
    const formData = new FormData();
    formData.set("name", "Test User");
    formData.set("email", "newuser@company.com");
    formData.set("password", "StrongPass123!");

    const result = await signupAction(undefined, formData);
    expect(result?.error).toContain("Terms of Service and Acceptable Use Policy");
  });

  it("includes workspace_legal_acknowledgements in GDPR export and removes them on account deletion", async () => {
    await LegalAckRoute.POST(
      new NextRequest("http://localhost:3000/api/v1/workspace/legal-acknowledgement", {
        method: "POST",
        body: JSON.stringify({ accepted: true }),
      })
    );

    const exported = await exportUserAccountData(userId);
    expect(exported.workspace_legal_acknowledgements.length).toBe(1);
    expect((exported.workspace_legal_acknowledgements[0] as any).terms_version).toBe("2026-11-v1");

    await deleteOwnAccount(userId, { password: "StrongPass123!" });

    const remaining = await db.workspace_legal_acknowledgements.findMany({
      where: { user_id: userId },
    });
    expect(remaining.length).toBe(0);
  });
});
