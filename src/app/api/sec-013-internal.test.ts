import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as tlsAskGet } from "./internal/tls-ask/route";
import { GET as healthGet } from "./health/route";

const mockGetSessionUser = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

vi.mock("@/server/queues", () => ({
  getRedisConnection: () => ({
    ping: async () => "PONG",
    get: async () =>
      JSON.stringify({ timestamp: "2026-11-27T00:00:00Z", schedulersEnabled: true }),
  }),
}));

describe("SEC-013 Internal TLS-Ask & Health Diagnostics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fails closed in production when CTD_TLS_ASK_SECRET is missing even with localhost Host header", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.CTD_TLS_ASK_SECRET;

    const req = new NextRequest("http://localhost:3000/api/internal/tls-ask?domain=track.example.com", {
      headers: { host: "localhost:3000" },
    });

    const res = await tlsAskGet(req);
    expect(res.status).toBe(403);
  });

  it("allows tls-ask in production when valid CTD_TLS_ASK_SECRET is provided", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.CTD_TLS_ASK_SECRET = "super-secret-tls-ask";
    process.env.APP_URL = "https://app.example.com";

    const req = new NextRequest(
      "http://web:3000/api/internal/tls-ask?domain=app.example.com&secret=super-secret-tls-ask",
      { headers: { host: "web:3000" } }
    );

    const res = await tlsAskGet(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.allowed).toBe(true);
  });

  it("returns only minimal { ok } on /api/health to anonymous callers", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/health");
    const res = await healthGet(req);
    const json = await res.json();

    expect(Object.keys(json)).toEqual(["ok"]);
    expect(json).not.toHaveProperty("components");
    expect(json).not.toHaveProperty("worker");
  });

  it("returns detailed diagnostics on /api/health to admins or valid internal header", async () => {
    mockGetSessionUser.mockResolvedValueOnce({
      user: { id: "admin-1", role: "super_admin" },
    });

    const adminReq = new NextRequest("http://localhost:3000/api/health");
    const adminRes = await healthGet(adminReq);
    const adminJson = await adminRes.json();
    expect(adminJson).toHaveProperty("components");
    expect(adminJson.components).toHaveProperty("worker");

    mockGetSessionUser.mockResolvedValueOnce(null);
    process.env.CTD_TLS_ASK_SECRET = "health-internal-secret";
    const internalReq = new NextRequest("http://localhost:3000/api/health", {
      headers: { "x-internal-health-secret": "health-internal-secret" },
    });
    const internalRes = await healthGet(internalReq);
    const internalJson = await internalRes.json();
    expect(internalJson).toHaveProperty("components");
  });
});
