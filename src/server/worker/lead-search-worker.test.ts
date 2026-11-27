import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/server/db";

const { mockIsApifyConfigured, mockSearchGmaps, mockTrackUsageIncrement, mockLoggerError } = vi.hoisted(() => ({
  mockIsApifyConfigured: vi.fn(),
  mockSearchGmaps: vi.fn(),
  mockTrackUsageIncrement: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/server/providers/leads/apify/config", () => ({
  isApifyConfigured: () => mockIsApifyConfigured(),
  getApifySettings: vi.fn(),
}));

vi.mock("@/server/providers/leads/apify/google-maps.adapter", () => ({
  searchGoogleMapsApify: (...args: any[]) => mockSearchGmaps(...args),
}));

vi.mock("@/server/billing/usage-tracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/billing/usage-tracker")>();
  return {
    ...actual,
    trackUsageIncrement: (...args: any[]) => mockTrackUsageIncrement(...args),
  };
});

vi.mock("@/server/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: any[]) => mockLoggerError(...args),
  },
}));

import { executeLeadSearch, recoverStuckLeadSearches } from "./lead-search-worker";

describe("Phase 6c Item 3 (BUG-017): Lead Search Worker Atomic Claim, Stuck Recovery & Usage Logging", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsApifyConfigured.mockResolvedValue(true);
    mockTrackUsageIncrement.mockResolvedValue({ quantity: 1, period: "2026-11" });
  });

  it("atomically claims queued searches so concurrent executeLeadSearch runs execute at most once", async () => {
    const userId = uid("user-atomic");
    const search = await db.lead_searches.create({
      data: {
        id: uid("search-atomic"),
        user_id: userId,
        source: "google_maps",
        provider_used: "apify",
        params: { keyword: "cafe", location: "Boston", max_results: 5 },
        status: "queued",
        started_at: new Date(),
      },
    });

    mockIsApifyConfigured.mockResolvedValue(false);
    await Promise.all([executeLeadSearch(search.id), executeLeadSearch(search.id)]);

    expect(mockIsApifyConfigured).toHaveBeenCalledTimes(1);
    const updated = await db.lead_searches.findUnique({ where: { id: search.id } });
    expect(updated?.status).toBe("failed");
  });

  it("allows BullMQ stalled/retried jobs to reclaim a running search and logs usage increment errors", async () => {
    const userId = uid("user-retry");
    const search = await db.lead_searches.create({
      data: {
        id: uid("search-retry"),
        user_id: userId,
        source: "google_maps",
        provider_used: "apify",
        params: { keyword: "cafe", location: "Boston", max_results: 5, find_emails: false },
        status: "running",
        started_at: new Date(),
      },
    });

    mockSearchGmaps.mockResolvedValue({
      lineResults: [{ success: true }],
      allLeads: [
        {
          companyName: "Boston Coffee Co",
          city: "Boston",
          country: "US",
          sourceRef: "gmaps-1",
        },
      ],
    });
    mockTrackUsageIncrement.mockRejectedValue(new Error("DB timeout updating usage_counters"));

    await executeLeadSearch(search.id, { allowRetryReclaim: true });

    expect(mockSearchGmaps).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ userId, searchId: search.id, count: 1 }),
      "Failed to increment monthly_leads usage counter"
    );
    const updated = await db.lead_searches.findUnique({ where: { id: search.id } });
    expect(updated?.status).toBe("completed");
  });

  it("recovers searches stuck in running for >30 minutes while leaving fresh searches untouched", async () => {
    const now = new Date();
    const fortyMinsAgo = new Date(now.getTime() - 40 * 60 * 1000);
    const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const stuckSearch = await db.lead_searches.create({
      data: {
        id: uid("search-stuck"),
        user_id: uid("user-stuck"),
        source: "google_maps",
        params: {},
        status: "running",
        started_at: fortyMinsAgo,
      },
    });

    const freshSearch = await db.lead_searches.create({
      data: {
        id: uid("search-fresh"),
        user_id: uid("user-fresh"),
        source: "google_maps",
        params: {},
        status: "running",
        started_at: fiveMinsAgo,
      },
    });

    const recovered = await recoverStuckLeadSearches(now);
    expect(recovered).toBeGreaterThanOrEqual(1);

    const updatedStuck = await db.lead_searches.findUnique({ where: { id: stuckSearch.id } });
    const updatedFresh = await db.lead_searches.findUnique({ where: { id: freshSearch.id } });

    expect(updatedStuck?.status).toBe("failed");
    expect(updatedStuck?.error).toContain("30 minutes");
    expect(updatedFresh?.status).toBe("running");
  });
});
