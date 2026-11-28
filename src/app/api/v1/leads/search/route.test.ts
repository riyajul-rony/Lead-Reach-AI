import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { startFreeTrialForUser } from "@/server/billing/trial";

const { mockSession, mockQueueLeadSearch, mockExecuteLeadSearch, mockIsApifyConfigured, mockGetApifySettings, mockLoggerError } =
  vi.hoisted(() => ({
    mockSession: vi.fn(),
    mockQueueLeadSearch: vi.fn(),
    mockExecuteLeadSearch: vi.fn(),
    mockIsApifyConfigured: vi.fn(),
    mockGetApifySettings: vi.fn(),
    mockLoggerError: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

vi.mock("@/server/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queues")>();
  return {
    ...actual,
    queueLeadSearch: (...args: any[]) => mockQueueLeadSearch(...args),
  };
});

vi.mock("@/server/providers/leads/apify/config", () => ({
  isApifyConfigured: () => mockIsApifyConfigured(),
  getApifySettings: () => mockGetApifySettings(),
}));

vi.mock("@/server/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: any[]) => mockLoggerError(...args),
  },
}));

vi.mock("@/server/worker/lead-search-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/worker/lead-search-worker")>();
  return {
    ...actual,
    executeLeadSearch: (...args: any[]) => mockExecuteLeadSearch(...args),
  };
});

import { POST } from "./route";

describe("Phase 6c Item 3 (BUG-017): POST /api/v1/leads/search", () => {
  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsApifyConfigured.mockResolvedValue(true);
    mockGetApifySettings.mockResolvedValue({
      limits: {
        maxLeadsPerRun: { google_maps: 100, meta_ads: 100, b2b_leads: 100 },
        maxLinesPerRun: 10,
      },
    });
    mockQueueLeadSearch.mockResolvedValue(true);
    mockExecuteLeadSearch.mockResolvedValue(undefined);
  });

  it("checks monthly_leads against the real requested clampedMax amount (not 1)", async () => {
    const userId = uid("user-quota");
    await db.users.create({
      data: { id: userId, email: `${userId}@test.io`, role: "user", status: "active", plan: "free" },
    });
    await startFreeTrialForUser(userId, { trialDays: 14 });
    // Free plan default monthly_leads = 100; override to 10 and record 5 used -> 5 remaining
    await db.user_limit_overrides.upsert({
      where: { user_id: userId },
      create: { user_id: userId, monthly_leads: 10 },
      update: { monthly_leads: 10 },
    });
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await db.usage_counters.upsert({
      where: { user_id_resource_period: { user_id: userId, resource: "monthly_leads", period } },
      create: { user_id: userId, resource: "monthly_leads", period, quantity: 5 },
      update: { quantity: 5 },
    });

    mockSession.mockResolvedValue({
      user: { id: userId, email: `${userId}@test.io`, role: "user", email_verified_at: new Date() },
    });

    // Requesting 20 leads when only 5 remain must be rejected with 429
    const reqOver = new NextRequest("http://localhost:3000/api/v1/leads/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "google_maps",
        keyword: "dentist",
        location: "New York",
        max_results: 20,
      }),
    });
    const resOver = await POST(reqOver);
    expect(resOver.status).toBe(429);
    expect(mockQueueLeadSearch).not.toHaveBeenCalled();

    // Requesting 5 leads when 5 remain is allowed and queues ONLY to BullMQ (no concurrent direct run)
    const reqOk = new NextRequest("http://localhost:3000/api/v1/leads/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "google_maps",
        keyword: "dentist",
        location: "New York",
        max_results: 5,
      }),
    });
    const resOk = await POST(reqOk);
    expect(resOk.status).toBe(200);
    expect(mockQueueLeadSearch).toHaveBeenCalledTimes(1);
    expect(mockExecuteLeadSearch).not.toHaveBeenCalled();
  });

  it("falls back to direct executeLeadSearch ONLY when queueLeadSearch fails", async () => {
    const userId = uid("user-fallback");
    await db.users.create({
      data: { id: userId, email: `${userId}@test.io`, role: "user", status: "active", plan: "agency" },
    });
    mockSession.mockResolvedValue({
      user: { id: userId, email: `${userId}@test.io`, role: "user", email_verified_at: new Date() },
    });
    mockQueueLeadSearch.mockResolvedValue(false);

    const req = new NextRequest("http://localhost:3000/api/v1/leads/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "google_maps",
        keyword: "plumber",
        location: "Austin",
        max_results: 5,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockQueueLeadSearch).toHaveBeenCalledTimes(1);
    expect(mockExecuteLeadSearch).toHaveBeenCalledTimes(1);
  });
});
