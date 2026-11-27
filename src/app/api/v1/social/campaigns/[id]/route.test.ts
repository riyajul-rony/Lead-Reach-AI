import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { PATCH } from "./route";

const mockGetSessionUser = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

describe("SEC-005 PATCH /api/v1/social/campaigns/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects mass-assignment of user_id or unknown fields with 400", async () => {
    const campaign = await db.social_campaigns.create({
      data: {
        user_id: "user-social-1",
        social_account_id: "00000000-0000-0000-0000-000000000001",
        name: "My Campaign",
        timezone: "UTC",
      },
    });

    mockGetSessionUser.mockResolvedValueOnce({ user: { id: "user-social-1" } });

    const req = new NextRequest(`http://localhost:3000/api/v1/social/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated",
        user_id: "attacker-user",
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(400);

    const unchanged = await db.social_campaigns.findUnique({ where: { id: campaign.id } });
    expect(unchanged?.user_id).toBe("user-social-1");
    expect(unchanged?.name).toBe("My Campaign");
  });

  it("rejects cross-tenant social_account_id or openai_key_id with 403", async () => {
    const otherAccount = await db.social_accounts.create({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "user-social-other",
        provider: "facebook",
        provider_account_id: "fb-other",
        display_name: "Other Page",
        access_token_enc: "enc",
      },
    });

    const otherKey = await db.api_keys.create({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        user_id: "user-social-other",
        provider: "openai",
        label: "Other Key",
        key_enc: "enc",
      },
    });

    const campaign = await db.social_campaigns.create({
      data: {
        user_id: "user-social-owner",
        social_account_id: "00000000-0000-0000-0000-000000000002",
        name: "Owner Campaign",
        timezone: "UTC",
      },
    });

    mockGetSessionUser.mockResolvedValue({ user: { id: "user-social-owner" } });

    const reqAccount = new NextRequest(
      `http://localhost:3000/api/v1/social/campaigns/${campaign.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ social_account_id: otherAccount.id }),
      }
    );
    const resAccount = await PATCH(reqAccount, { params: Promise.resolve({ id: campaign.id }) });
    expect(resAccount.status).toBe(403);

    const reqKey = new NextRequest(
      `http://localhost:3000/api/v1/social/campaigns/${campaign.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openai_key_id: otherKey.id }),
      }
    );
    const resKey = await PATCH(reqKey, { params: Promise.resolve({ id: campaign.id }) });
    expect(resKey.status).toBe(403);
  });

  it("allows valid allowlisted fields and owned references", async () => {
    const ownedAccount = await db.social_accounts.create({
      data: {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: "user-social-valid",
        provider: "facebook",
        provider_account_id: "fb-valid",
        display_name: "Valid Page",
        access_token_enc: "enc",
      },
    });

    const campaign = await db.social_campaigns.create({
      data: {
        user_id: "user-social-valid",
        social_account_id: ownedAccount.id,
        name: "Initial Name",
        timezone: "UTC",
      },
    });

    mockGetSessionUser.mockResolvedValueOnce({ user: { id: "user-social-valid" } });

    const req = new NextRequest(`http://localhost:3000/api/v1/social/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Campaign",
        status: "paused",
        social_account_id: ownedAccount.id,
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Renamed Campaign");
    expect(json.data.status).toBe("paused");
  });
});
