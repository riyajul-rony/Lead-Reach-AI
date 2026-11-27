import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/server/db";
import { GET as scraperStatusGet } from "./leads/scraper/status/route";
import { GET as leadsLimitsGet } from "./leads/limits/route";
import { GET as socialCampaignsGet } from "./social/campaigns/route";
import { GET as socialPostsGet } from "./social/posts/route";

const mockGetSessionUser = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

describe("SEC-011 Auth & Token Projection Guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests to leads/scraper/status and leads/limits with 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    const statusRes = await scraperStatusGet();
    expect(statusRes.status).toBe(401);

    const limitsRes = await leadsLimitsGet();
    expect(limitsRes.status).toBe(401);
  });

  it("excludes *_enc fields from social/campaigns and social/posts responses", async () => {
    const account = await db.social_accounts.create({
      data: {
        user_id: "user-sec011",
        provider: "facebook",
        external_id: "fb-sec011",
        display_name: "Sec011 Page",
        access_token_enc: "SECRET_ENCRYPTED_ACCESS_TOKEN",
        refresh_token_enc: "SECRET_ENCRYPTED_REFRESH_TOKEN",
      },
    });

    const campaign = await db.social_campaigns.create({
      data: {
        user_id: "user-sec011",
        social_account_id: account.id,
        name: "Sec011 Campaign",
        timezone: "UTC",
      },
    });

    await db.post_runs.create({
      data: {
        user_id: "user-sec011",
        campaign_id: campaign.id,
        status: "published",
        scheduled_for: new Date(),
      },
    });

    mockGetSessionUser.mockResolvedValue({ user: { id: "user-sec011" } });

    const campaignsRes = await socialCampaignsGet(
      new Request("http://localhost:3000/api/v1/social/campaigns") as any
    );
    expect(campaignsRes.status).toBe(200);
    const campaignsBody = JSON.stringify(await campaignsRes.json());
    expect(campaignsBody).not.toContain("access_token_enc");
    expect(campaignsBody).not.toContain("refresh_token_enc");
    expect(campaignsBody).not.toContain("SECRET_ENCRYPTED_ACCESS_TOKEN");

    const postsRes = await socialPostsGet();
    expect(postsRes.status).toBe(200);
    const postsBody = JSON.stringify(await postsRes.json());
    expect(postsBody).not.toContain("access_token_enc");
    expect(postsBody).not.toContain("refresh_token_enc");
    expect(postsBody).not.toContain("SECRET_ENCRYPTED_ACCESS_TOKEN");
  });
});
