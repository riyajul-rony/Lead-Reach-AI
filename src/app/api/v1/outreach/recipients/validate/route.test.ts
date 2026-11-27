import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

const mockSession = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockSession(),
}));

import { POST } from "./route";

describe("Phase 6c Item 2 (BUG-016): POST /api/v1/outreach/recipients/validate", () => {
  const userId = `user-validate-${Date.now()}`;
  const searchId = `search-validate-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockResolvedValue({
      sessionId: "sess-1",
      user: { id: userId, email: "owner@agency.io", role: "user" },
    });
  });

  it("selects only real Prisma leads columns, treats onlyEnriched as having email, and preserves timezone", async () => {
    await db.leads.create({
      data: {
        id: `lead-enriched-new-${Date.now()}`,
        user_id: userId,
        search_id: searchId,
        dedupe_key: `dk-1-${Date.now()}`,
        company_name: "Acme Plumbing",
        email: "founder@acmeplumbing.com",
        phone: "+12125550100",
        phone_raw: "(212) 555-0100",
        website: "https://acmeplumbing.com",
        city: "New York",
        country: "US",
        timezone: "America/New_York",
        source: "google_maps",
        status: "new", // Freshly enriched leads remain status: "new"
        extra: { founder_name: "Jane Doe", job_title: "Founder" },
      },
    });

    await db.leads.create({
      data: {
        id: `lead-no-email-${Date.now()}`,
        user_id: userId,
        search_id: searchId,
        dedupe_key: `dk-2-${Date.now()}`,
        company_name: "No Email Co",
        email: null,
        source: "google_maps",
        status: "contacted",
      },
    });

    const findManySpy = vi.spyOn(db.leads, "findMany");

    const req = new NextRequest("http://localhost:3000/api/v1/outreach/recipients/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "leads",
        searchId,
        onlyWithEmail: false,
        onlyEnriched: true,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(findManySpy).toHaveBeenCalledTimes(1);

    const callArgs = findManySpy.mock.calls[0][0] as {
      select?: Record<string, boolean>;
      where: { email?: unknown; status?: unknown };
    };
    const selectedKeys = Object.keys(callArgs.select || {});
    const allowedLeadsColumns = new Set<string>(Object.values(Prisma.LeadsScalarFieldEnum));
    for (const key of selectedKeys) {
      expect(allowedLeadsColumns.has(key)).toBe(true);
    }
    expect(selectedKeys).not.toContain("first_name");
    expect(selectedKeys).not.toContain("last_name");
    expect(selectedKeys).not.toContain("full_name");
    expect(selectedKeys).not.toContain("phone_e164");

    expect(callArgs.where.email).toEqual({ not: null });
    expect(callArgs.where.status).toBeUndefined();

    expect(json.data.summary.valid).toBe(1);
    expect(json.data.validRecipients).toHaveLength(1);
    expect(json.data.validRecipients[0]).toMatchObject({
      email: "founder@acmeplumbing.com",
      first_name: "Jane",
      last_name: "Doe",
      company: "Acme Plumbing",
      phone: "+12125550100",
      job_title: "Founder",
    });
    expect(json.data.validRecipients[0].vars?.timezone).toBe("America/New_York");
  });
});
