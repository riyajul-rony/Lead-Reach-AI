import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { encrypt } from "@/server/crypto";
import * as ExportRoute from "@/app/api/v1/account/export/route";
import * as AccountRoute from "@/app/api/v1/account/route";

const { mockSession } = vi.hoisted(() => ({
  mockSession: vi.fn(),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSessionUser: () => mockSession(),
    invalidateUserSessions: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/server/queues/manager", () => ({
  cancelUserJobs: vi.fn().mockResolvedValue(undefined),
}));

describe("Phase 5 Step 6: GDPR Data Export & Self-Service Account Deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication for export and deletion", async () => {
    mockSession.mockResolvedValue(null);

    const exportRes = await ExportRoute.GET();
    expect(exportRes.status).toBe(401);

    const delReq = new NextRequest("http://localhost:3000/api/v1/account", {
      method: "DELETE",
      body: JSON.stringify({ password: "secret" }),
    });
    const delRes = await AccountRoute.DELETE(delReq);
    expect(delRes.status).toBe(401);
  });

  it("exports only the requesting user's data and strictly redacts all secrets/hashes/tokens", async () => {
    const uidA = `u-gdpr-exp-a-${Date.now()}`;
    const uidB = `u-gdpr-exp-b-${Date.now()}`;
    const pwHash = await hashPassword("SuperSecretPass123!");

    await db.users.create({
      data: {
        id: uidA,
        email: `alice-${Date.now()}@example.com`,
        name: "Alice",
        password_hash: pwHash,
        role: "user",
        status: "active",
      },
    });
    await db.users.create({
      data: {
        id: uidB,
        email: `bob-${Date.now()}@example.com`,
        name: "Bob",
        password_hash: pwHash,
        role: "user",
        status: "active",
      },
    });

    await db.email_accounts.create({
      data: {
        id: `acc-a-${Date.now()}`,
        user_id: uidA,
        provider: "smtp",
        label: "Alice Inbox",
        from_email: "alice@company.com",
        smtp_password_enc: encrypt("alice-smtp-secret"),
        imap_password_enc: encrypt("alice-imap-secret"),
        oauth_access_token_enc: encrypt("alice-oauth-access"),
        oauth_refresh_token_enc: encrypt("alice-oauth-refresh"),
      },
    });
    await db.email_accounts.create({
      data: {
        id: `acc-b-${Date.now()}`,
        user_id: uidB,
        provider: "smtp",
        label: "Bob Inbox",
        from_email: "bob@other.com",
        smtp_password_enc: encrypt("bob-smtp-secret"),
      },
    });

    await db.api_keys.create({
      data: {
        id: `key-a-${Date.now()}`,
        user_id: uidA,
        provider: "openai",
        label: "Alice OpenAI",
        key_enc: encrypt("sk-alice-secret-key"),
        key_last4: "1234",
        status: "active",
      },
    });

    await db.leads.create({
      data: {
        id: `lead-a-${Date.now()}`,
        user_id: uidA,
        dedupe_key: `dedupe-a-${Date.now()}`,
        company_name: "Alice Prospect LLC",
        email: "prospect@alice-target.com",
        timezone: "America/New_York",
        source: "google_maps",
      },
    });
    await db.leads.create({
      data: {
        id: `lead-b-${Date.now()}`,
        user_id: uidB,
        dedupe_key: `dedupe-b-${Date.now()}`,
        company_name: "Bob Secret Prospect",
        email: "secret@bob-target.com",
        source: "google_maps",
      },
    });

    mockSession.mockResolvedValue({ user: { id: uidA, email: "alice@example.com" } });

    const res = await ExportRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("leadreach-account-export.json");

    const text = await res.text();
    const json = JSON.parse(text);

    // User isolation: Alice's data present, Bob's data strictly absent
    expect(json.profile.id).toBe(uidA);
    expect(json.email_accounts).toHaveLength(1);
    expect(json.email_accounts[0].from_email).toBe("alice@company.com");
    expect(json.leads).toHaveLength(1);
    expect(json.leads[0].company_name).toBe("Alice Prospect LLC");
    expect(json.leads[0].timezone).toBe("America/New_York");
    expect(text).not.toContain("Bob Secret Prospect");
    expect(text).not.toContain("bob@other.com");

    // Secret redaction: zero hashes, encrypted secrets, or OAuth tokens in JSON
    expect(json.profile.password_hash).toBeUndefined();
    expect(json.email_accounts[0].smtp_password_enc).toBeUndefined();
    expect(json.email_accounts[0].imap_password_enc).toBeUndefined();
    expect(json.email_accounts[0].oauth_access_token_enc).toBeUndefined();
    expect(json.email_accounts[0].oauth_refresh_token_enc).toBeUndefined();
    expect(json.api_keys[0].key_enc).toBeUndefined();
    expect(json.api_keys[0].key_last4).toBe("1234");
    expect(text).not.toContain(pwHash);
    expect(text).not.toContain("smtp_password_enc");
    expect(text).not.toContain("imap_password_enc");
    expect(text).not.toContain("oauth_access_token_enc");
    expect(text).not.toContain("key_enc");
  });

  it("enforces password check and cascades deletion across Phase 3 tables while preserving other users", async () => {
    const uidA = `u-gdpr-del-a-${Date.now()}`;
    const uidB = `u-gdpr-del-b-${Date.now()}`;
    const emailA = `del-alice-${Date.now()}@example.com`;
    const pwHash = await hashPassword("DeleteMePass123!");

    await db.users.create({
      data: {
        id: uidA,
        email: emailA,
        name: "Alice Delete",
        password_hash: pwHash,
        role: "user",
        status: "active",
      },
    });
    await db.users.create({
      data: {
        id: uidB,
        email: `keep-bob-${Date.now()}@example.com`,
        name: "Bob Keep",
        password_hash: pwHash,
        role: "user",
        status: "active",
      },
    });

    const accA1 = await db.email_accounts.create({
      data: {
        id: `acc-del-a1-${Date.now()}`,
        user_id: uidA,
        provider: "smtp",
        label: "A1",
        from_email: "a1@alice.com",
      },
    });
    const accA2 = await db.email_accounts.create({
      data: {
        id: `acc-del-a2-${Date.now()}`,
        user_id: uidA,
        provider: "smtp",
        label: "A2",
        from_email: "a2@alice.com",
      },
    });
    await db.email_accounts.create({
      data: {
        id: `acc-keep-b-${Date.now()}`,
        user_id: uidB,
        provider: "smtp",
        label: "B1",
        from_email: "b1@bob.com",
      },
    });

    // Phase 3 records for User A & User B
    const tdA = await db.tracking_domains.create({
      data: {
        id: `td-a-${Date.now()}`,
        user_id: uidA,
        domain: `track-${Date.now()}.alice.com`,
        cname_target: "track.leadreachai.test",
        status: "verified",
      },
    });
    await db.tracking_domains.create({
      data: {
        id: `td-b-${Date.now()}`,
        user_id: uidB,
        domain: `track-${Date.now()}.bob.com`,
        cname_target: "track.leadreachai.test",
        status: "verified",
      },
    });

    await db.warmup_logs.create({
      data: {
        id: `wu-a-${Date.now()}`,
        user_id: uidA,
        from_account_id: accA1.id,
        to_account_id: accA2.id,
        message_id: `<wu-a-${Date.now()}@alice.com>`,
        subject: "Warmup A",
        status: "sent",
      },
    });

    const campA = await db.outreach_campaigns.create({
      data: {
        id: `camp-del-a-${Date.now()}`,
        user_id: uidA,
        name: "Alice Running Campaign",
        mode: "custom",
        status: "running",
        timezone: "UTC",
        tracking_domain_id: tdA.id,
      },
    });

    await db.campaign_variants.create({
      data: {
        id: `var-a-${Date.now()}`,
        campaign_id: campA.id,
        step_no: 0,
        label: "Variant A",
        subject_template: "Hi",
        body_template: "Hello",
      },
    });

    mockSession.mockResolvedValue({ user: { id: uidA, email: emailA } });

    // Wrong password must fail with 403 and keep User A intact
    const badRes = await AccountRoute.DELETE(
      new NextRequest("http://localhost:3000/api/v1/account", {
        method: "DELETE",
        body: JSON.stringify({ password: "WrongPassword!" }),
      })
    );
    expect(badRes.status).toBe(403);
    expect(await db.users.findUnique({ where: { id: uidA } })).not.toBeNull();

    // Valid password deletes User A + Phase 3 tables and clears session cookie
    const okRes = await AccountRoute.DELETE(
      new NextRequest("http://localhost:3000/api/v1/account", {
        method: "DELETE",
        body: JSON.stringify({ password: "DeleteMePass123!" }),
      })
    );
    expect(okRes.status).toBe(200);
    const setCookie = okRes.headers.get("set-cookie") || "";
    expect(setCookie).toContain("leadreach_session=");

    expect(await db.users.findUnique({ where: { id: uidA } })).toBeNull();
    expect(await db.email_accounts.count({ where: { user_id: uidA } })).toBe(0);
    expect(await db.outreach_campaigns.count({ where: { user_id: uidA } })).toBe(0);
    expect(await db.warmup_logs.count({ where: { user_id: uidA } })).toBe(0);
    expect(await db.tracking_domains.count({ where: { user_id: uidA } })).toBe(0);
    expect(await db.campaign_variants.findMany({ where: { campaign_id: campA.id } })).toHaveLength(0);

    // User B remains completely untouched
    expect(await db.users.findUnique({ where: { id: uidB } })).not.toBeNull();
    expect(await db.email_accounts.count({ where: { user_id: uidB } })).toBe(1);
    expect(await db.tracking_domains.count({ where: { user_id: uidB } })).toBe(1);
  });

  it("allows OAuth-only users (no password_hash) to delete with explicit confirmation", async () => {
    const uidOAuth = `u-gdpr-oauth-${Date.now()}`;
    const emailOAuth = `oauth-only-${Date.now()}@gmail.com`;

    await db.users.create({
      data: {
        id: uidOAuth,
        email: emailOAuth,
        name: "OAuth User",
        password_hash: null,
        role: "user",
        status: "active",
      },
    });

    mockSession.mockResolvedValue({ user: { id: uidOAuth, email: emailOAuth } });

    const missingConfRes = await AccountRoute.DELETE(
      new NextRequest("http://localhost:3000/api/v1/account", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "nope" }),
      })
    );
    expect(missingConfRes.status).toBe(400);

    const okRes = await AccountRoute.DELETE(
      new NextRequest("http://localhost:3000/api/v1/account", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE" }),
      })
    );
    expect(okRes.status).toBe(200);
    expect(await db.users.findUnique({ where: { id: uidOAuth } })).toBeNull();
  });
});
