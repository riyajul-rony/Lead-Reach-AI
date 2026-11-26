import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import * as accountService from "@/server/email/account-service";
import * as AccountsRoute from "@/app/api/v1/email-accounts/route";
import * as AccountByIdRoute from "@/app/api/v1/email-accounts/[id]/route";

const { mockSession } = vi.hoisted(() => ({
  mockSession: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

vi.mock("@/server/billing/limits", () => ({
  assertLimit: vi.fn().mockResolvedValue(true),
}));

describe("Email Accounts Duplicate Handling & OAuth Upgrade", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Returns 409 JSON (not 500 or raw Prisma text) when email already exists for user_id", async () => {
    const userId = `u-dup-${Date.now()}`;
    const existingEmail = `dup-${Date.now()}@gmail.com`;

    const existing = await db.email_accounts.create({
      data: {
        user_id: userId,
        provider: "gmail_api",
        label: "Existing OAuth",
        from_email: existingEmail,
        status: "active",
        warmup_enabled: false,
      },
    });

    mockSession.mockResolvedValue({ user: { id: userId, email: existingEmail } });

    const req = new NextRequest("http://localhost:3000/api/v1/email-accounts", {
      method: "POST",
      body: JSON.stringify({
        from_email: existingEmail,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_password: "abcdefghijklmnop",
      }),
    });

    const res = await AccountsRoute.POST(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("This email account is already connected.");
    expect(json.existingAccountId).toBe(existing.id);
  });

  it("2. Catches Prisma P2002 and other raw Prisma errors without leaking internal messages", async () => {
    const userId = `u-p2002-${Date.now()}`;
    const email = `race-${Date.now()}@gmail.com`;
    mockSession.mockResolvedValue({ user: { id: userId, email } });

    // Case A: Simulated Prisma P2002 race condition
    const p2002Err: any = new Error(
      "Invalid `prisma.email_accounts.create()` invocation: Unique constraint failed on the constraint: `email_accounts_user_id_from_email_key`"
    );
    p2002Err.code = "P2002";
    vi.spyOn(accountService, "createEmailAccount").mockRejectedValueOnce(p2002Err);

    const reqP2002 = new NextRequest("http://localhost:3000/api/v1/email-accounts", {
      method: "POST",
      body: JSON.stringify({
        from_email: email,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_password: "abcdefghijklmnop",
      }),
    });
    const resP2002 = await AccountsRoute.POST(reqP2002);
    expect(resP2002.status).toBe(409);
    const jsonP2002 = await resP2002.json();
    expect(jsonP2002.error).toBe("This email account is already connected.");
    expect(jsonP2002.error).not.toContain("prisma");
    expect(jsonP2002.error).not.toContain("Unique constraint");

    // Case B: Generic Prisma error never leaks raw invocation string
    const rawPrismaErr: any = new Error(
      "Invalid `prisma.email_accounts.create()` invocation: Foreign key constraint violated"
    );
    rawPrismaErr.code = "P2003";
    vi.spyOn(accountService, "createEmailAccount").mockRejectedValueOnce(rawPrismaErr);

    const reqOther = new NextRequest("http://localhost:3000/api/v1/email-accounts", {
      method: "POST",
      body: JSON.stringify({
        from_email: email,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_password: "abcdefghijklmnop",
      }),
    });
    const resOther = await AccountsRoute.POST(reqOther);
    expect(resOther.status).toBe(500);
    const jsonOther = await resOther.json();
    expect(jsonOther.error).not.toContain("prisma");
    expect(jsonOther.error).not.toContain("invocation");
  });

  it("3. Upgrades an existing OAuth send-only account via PATCH /api/v1/email-accounts/[id]", async () => {
    const userId = `u-upgrade-${Date.now()}`;
    const targetEmail = `oauth-upgrade-${Date.now()}@gmail.com`;

    const oauthAcc = await db.email_accounts.create({
      data: {
        user_id: userId,
        provider: "gmail_api",
        label: "OAuth Inbox",
        from_email: targetEmail,
        status: "active",
        warmup_enabled: false,
      },
    });

    mockSession.mockResolvedValue({ user: { id: userId, email: targetEmail } });

    const req = new NextRequest(`http://localhost:3000/api/v1/email-accounts/${oauthAcc.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        provider: "smtp",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_username: targetEmail,
        smtp_password: "abcdefghijklmnop",
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: targetEmail,
        imap_password: "abcdefghijklmnop",
        warmup_enabled: true,
        status: "active",
      }),
    });

    const res = await AccountByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: oauthAcc.id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.provider).toBe("smtp");
    expect(json.data.smtp_host).toBe("smtp.gmail.com");
    expect(json.data.imap_host).toBe("imap.gmail.com");
    expect(json.data.has_smtp_password).toBe(true);
    expect(json.data.has_imap_password).toBe(true);
    expect(json.data.has_reply_detection).toBe(true);
    expect(json.data.warmup_enabled).toBe(true);
  });
});
