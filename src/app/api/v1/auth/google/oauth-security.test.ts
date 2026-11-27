import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import {
  OAUTH_STATE_COOKIE,
  createOAuthState,
  sanitizeReturnTo,
  verifyOAuthState,
} from "@/server/auth/oauth-state";
import { GET as googleCallbackGet } from "./callback/route";
import { GET as outreachCallbackGet } from "./outreach/callback/route";
import {
  exchangeGoogleCode,
  getGoogleConnectionStatus,
} from "@/server/integrations/google-sheets";

const mockGetSessionUser = vi.fn();
const mockCreateSession = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
  createSession: (...args: any[]) => mockCreateSession(...args),
}));

const mockCookiesGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mockCookiesGet,
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@/server/config", () => ({
  getAppUrl: async () => "http://localhost:3000",
  getConfig: async (key: string) => {
    if (key === "GOOGLE_CLIENT_ID") return "test-client-id";
    if (key === "GOOGLE_CLIENT_SECRET") return "test-client-secret";
    return null;
  },
  getRegistrationMode: async () => "open",
}));

describe("SEC-002, SEC-003, SEC-004 Google OAuth Security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookiesGet.mockReturnValue(undefined);
  });

  it("restricts returnTo to single-slash relative paths (blocks open redirects)", () => {
    expect(sanitizeReturnTo("https://evil.com")).toBe("/app");
    expect(sanitizeReturnTo("//evil.com")).toBe("/app");
    expect(sanitizeReturnTo("/\\evil.com")).toBe("/app");
    expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/app");
    expect(sanitizeReturnTo("/app/outreach?tab=accounts")).toBe("/app/outreach?tab=accounts");
  });

  it("rejects tampered, missing-nonce, or mismatched-nonce OAuth state", () => {
    const { state, nonce } = createOAuthState({
      mode: "outreach",
      userId: "user-1",
      returnTo: "/app/outreach/email-accounts",
    });

    expect(verifyOAuthState(state, undefined).valid).toBe(false);
    expect(verifyOAuthState(state, "wrong-nonce").valid).toBe(false);
    expect(verifyOAuthState(`${state}tamper`, nonce).valid).toBe(false);
    expect(verifyOAuthState(state, nonce).valid).toBe(true);
  });

  it("blocks cross-tenant mailbox injection in outreach/callback when session user != state userId", async () => {
    const { state, nonce } = createOAuthState({
      mode: "outreach",
      userId: "victim-user",
      returnTo: "/app/outreach/email-accounts",
    });

    mockGetSessionUser.mockResolvedValueOnce({ user: { id: "attacker-user" } });

    const req = new NextRequest(
      `http://localhost:3000/api/v1/auth/google/outreach/callback?code=abc&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${nonce}`,
        },
      }
    );

    const res = await outreachCallbackGet(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=unauthorized");
  });

  it("blocks unauthenticated outreach/callback even with valid state", async () => {
    const { state, nonce } = createOAuthState({
      mode: "outreach",
      userId: "victim-user",
      returnTo: "/app/outreach/email-accounts",
    });

    mockGetSessionUser.mockResolvedValueOnce(null);

    const req = new NextRequest(
      `http://localhost:3000/api/v1/auth/google/outreach/callback?code=abc&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${nonce}`,
        },
      }
    );

    const res = await outreachCallbackGet(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=unauthorized");
  });

  it("rejects Google login when profile email is missing or unverified", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: "unverified@example.com", verified_email: false }), {
          status: 200,
        })
      );

    await expect(exchangeGoogleCode("code-1")).rejects.toThrow(/missing or not verified/i);
    fetchMock.mockRestore();
  });

  it("blocks Google login for suspended/inactive users", async () => {
    await db.users.create({
      data: {
        email: "suspended@example.com",
        name: "Suspended User",
        role: "user",
        status: "suspended",
        plan: "free",
      },
    });

    const { state, nonce } = createOAuthState({
      mode: "login",
      returnTo: "/app",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ email: "suspended@example.com", verified_email: true, name: "Suspended" }),
          { status: 200 }
        )
      );

    const req = new NextRequest(
      `http://localhost:3000/api/v1/auth/google/callback?code=code-2&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${nonce}`,
        },
      }
    );

    const res = await googleCallbackGet(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=account_inactive");
    expect(mockCreateSession).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("does not leak Google Sheets connection from shared cookie when user has no DB row", async () => {
    mockCookiesGet.mockReturnValue({ value: "some-encrypted-cookie-from-user-a" });
    const status = await getGoogleConnectionStatus("user-b-no-google");
    expect(status.connected).toBe(false);
    expect(mockCookiesGet).not.toHaveBeenCalled();
  });
});
