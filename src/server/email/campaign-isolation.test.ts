import { describe, it, expect } from "vitest";
import { db } from "@/server/db";
import { createEmailAccount, updateEmailAccount } from "./account-service";
import { createOutreachCampaign, getCampaignDetails } from "./campaign-service";

describe("BUG-006 & BUG-007: Account Ownership & Encrypted Field Sanitization", () => {
  it("prevents cross-tenant account allocation updates and strips encrypted fields from campaign details", async () => {
    const userA = `u-iso-a-${Date.now()}`;
    const userB = `u-iso-b-${Date.now()}`;

    const accA = await db.email_accounts.create({
      data: {
        id: `acc-iso-a-${Date.now()}`,
        user_id: userA,
        provider: "smtp",
        label: "User A Inbox",
        from_email: `a-${Date.now()}@domain-a.com`,
        status: "active",
        daily_limit: 40,
        smtp_password_enc: "super-secret-smtp-a",
        imap_password_enc: "super-secret-imap-a",
        oauth_access_token_enc: "super-secret-oauth-a",
        oauth_refresh_token_enc: "super-secret-refresh-a",
      },
    });

    const accB = await db.email_accounts.create({
      data: {
        id: `acc-iso-b-${Date.now()}`,
        user_id: userB,
        provider: "smtp",
        label: "User B Inbox",
        from_email: `b-${Date.now()}@domain-b.com`,
        status: "active",
        daily_limit: 30,
        smtp_password_enc: "super-secret-smtp-b",
      },
    });

    // User A creates a campaign and attempts to pass User B's accountId in accountAllocations
    const { campaign } = await createOutreachCampaign(userA, {
      name: "Isolation Check Campaign",
      mode: "custom",
      recipientSource: "manual",
      senderAccountIds: [accA.id],
      recipients: [{ email: "prospect@example.com" }],
      subjectTemplate: "Hi",
      bodyTemplate: "Hello",
      timezone: "UTC",
      launchNow: false,
      accountAllocations: [
        { accountId: accA.id, leadCount: 1, dailyLimit: 55 },
        { accountId: accB.id, leadCount: 1, dailyLimit: 200 },
      ],
    });

    // User B's daily_limit must remain untouched (30, not 200)
    const accBAfter = await db.email_accounts.findUnique({ where: { id: accB.id } });
    expect(accBAfter?.daily_limit).toBe(30);

    // User A's daily_limit was updated (55)
    const accAAfter = await db.email_accounts.findUnique({ where: { id: accA.id } });
    expect(accAAfter?.daily_limit).toBe(55);

    // getCampaignDetails must NEVER expose encrypted fields
    const detail = await getCampaignDetails(userA, campaign.id);
    expect(detail).not.toBeNull();
    expect(detail!.senderAccounts).toHaveLength(1);
    const returnedAcc = detail!.senderAccounts[0];
    expect(returnedAcc.smtp_password_enc).toBeUndefined();
    expect(returnedAcc.imap_password_enc).toBeUndefined();
    expect(returnedAcc.oauth_access_token_enc).toBeUndefined();
    expect(returnedAcc.oauth_refresh_token_enc).toBeUndefined();
    expect(returnedAcc.has_smtp_password).toBe(true);
  });

  it("rejects linking another user's reply_inbox_account_id on create or update", async () => {
    const userA = `u-ri-a-${Date.now()}`;
    const userB = `u-ri-b-${Date.now()}`;

    const accB = await db.email_accounts.create({
      data: {
        id: `acc-ri-b-${Date.now()}`,
        user_id: userB,
        provider: "smtp",
        label: "User B Reply Inbox",
        from_email: `rib-${Date.now()}@domain-b.com`,
        status: "active",
      },
    });

    await expect(
      createEmailAccount(userA, {
        label: "User A Hijack Attempt",
        from_email: `ria-${Date.now()}@domain-a.com`,
        reply_inbox_account_id: accB.id,
        smtp_host: "smtp.domain-a.com",
        smtp_port: 587,
        smtp_username: "ria@domain-a.com",
        smtp_password: "password123",
      })
    ).rejects.toThrow("Selected reply inbox account not found");

    const accA = await createEmailAccount(userA, {
      label: "User A Clean",
      from_email: `ria-clean-${Date.now()}@domain-a.com`,
      smtp_host: "smtp.domain-a.com",
      smtp_port: 587,
      smtp_username: "ria@domain-a.com",
      smtp_password: "password123",
    });

    await expect(
      updateEmailAccount(userA, accA.id, { reply_inbox_account_id: accB.id })
    ).rejects.toThrow("Selected reply inbox account not found");
  });
});
