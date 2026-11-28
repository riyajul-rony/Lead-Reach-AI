import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { sha256 } from "@/server/auth/token";
import { localDevStore } from "@/test/local-store";

const cookieStore = new Map<string, string>();
const cacheStore = new Map<string, unknown>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = cookieStore.get(name);
      return v ? { value: v } : undefined;
    },
    set: (name: string, value: string) => {
      cookieStore.set(name, value);
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/server/cache", () => ({
  cacheGet: async (k: string) => cacheStore.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => {
    cacheStore.set(k, v);
  },
  cacheDel: async (...keys: string[]) => {
    for (const k of keys) cacheStore.delete(k);
  },
  cacheDelPattern: async () => {},
  cacheFindKeys: async (pattern: string) => {
    const prefix = pattern.replace(/\*$/, "");
    return [...cacheStore.keys()].filter((k) => k.startsWith(prefix));
  },
}));

import { changePasswordAction } from "./actions";

function makeForm(currentPassword: string, newPassword: string): FormData {
  const fd = new FormData();
  fd.set("currentPassword", currentPassword);
  fd.set("newPassword", newPassword);
  return fd;
}

describe("changePasswordAction", () => {
  let userId: string;
  let currentSessionId: string;
  let otherSessionId: string;
  const currentToken = "tok-current-session";
  const otherToken = "tok-other-session";

  beforeEach(async () => {
    cookieStore.clear();
    cacheStore.clear();
    (globalThis as unknown as { __rl?: unknown }).__rl = undefined;

    const email = `pwtest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const initialHash = await hashPassword("OldPassword123!");
    const created = await db.users.create({
      data: {
        email,
        name: "PW Tester",
        password_hash: initialHash,
        role: "user",
        status: "active",
        email_verified_at: new Date(),
        onboarded_at: new Date(),
      },
    });
    userId = created.id;

    const s1 = await db.sessions.create({
      data: {
        user_id: userId,
        token_hash: sha256(currentToken),
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });
    currentSessionId = s1.id;

    const s2 = await db.sessions.create({
      data: {
        user_id: userId,
        token_hash: sha256(otherToken),
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });
    otherSessionId = s2.id;

    cookieStore.set("leadreach_session", currentToken);
    cacheStore.set(`user_session:${userId}:${sha256(currentToken)}`, "1");
    cacheStore.set(`session:${sha256(currentToken)}`, { id: currentSessionId });
    cacheStore.set(`user_session:${userId}:${sha256(otherToken)}`, "1");
    cacheStore.set(`session:${sha256(otherToken)}`, { id: otherSessionId });
  });

  it("rejects unauthenticated callers", async () => {
    cookieStore.clear();
    const res = await changePasswordAction(undefined, makeForm("OldPassword123!", "NewPassword456!"));
    expect(res?.error).toMatch(/logged in/i);
  });

  it("rejects Google Sign-In users who have no password_hash", async () => {
    await db.users.update({ where: { id: userId }, data: { password_hash: null } });
    const res = await changePasswordAction(undefined, makeForm("anything", "NewPassword456!"));
    expect(res?.error).toMatch(/Google Sign-In/i);
  });

  it("rejects incorrect current password without updating hash", async () => {
    const res = await changePasswordAction(undefined, makeForm("WrongPassword!", "NewPassword456!"));
    expect(res?.error).toMatch(/incorrect/i);

    const user = await db.users.findUnique({ where: { id: userId } });
    expect(await verifyPassword(user!.password_hash!, "OldPassword123!")).toBe(true);
    expect(await verifyPassword(user!.password_hash!, "NewPassword456!")).toBe(false);
  });

  it("validates new password using signup strength rules", async () => {
    const shortRes = await changePasswordAction(undefined, makeForm("OldPassword123!", "short"));
    expect(shortRes?.error).toMatch(/at least 8 characters/i);

    const longRes = await changePasswordAction(
      undefined,
      makeForm("OldPassword123!", "a".repeat(201))
    );
    expect(longRes?.error).toMatch(/too long/i);
  });

  it("rejects reusing the same password", async () => {
    const res = await changePasswordAction(undefined, makeForm("OldPassword123!", "OldPassword123!"));
    expect(res?.error).toMatch(/different/i);
  });

  it("hashes and saves new password and invalidates only other sessions", async () => {
    const res = await changePasswordAction(undefined, makeForm("OldPassword123!", "NewPassword456!"));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/successfully updated/i);

    const user = await db.users.findUnique({ where: { id: userId } });
    expect(await verifyPassword(user!.password_hash!, "NewPassword456!")).toBe(true);
    expect(await verifyPassword(user!.password_hash!, "OldPassword123!")).toBe(false);

    // Current session stays alive in DB & cache; other session is removed
    const kept = localDevStore.findSession((s) => s.id === currentSessionId);
    const removed = localDevStore.findSession((s) => s.id === otherSessionId);
    expect(kept).toBeTruthy();
    expect(removed).toBeNull();
    expect(cacheStore.has(`session:${sha256(currentToken)}`)).toBe(true);
    expect(cacheStore.has(`session:${sha256(otherToken)}`)).toBe(false);
    expect(cacheStore.has(`user_session:${userId}:${sha256(otherToken)}`)).toBe(false);
  });

  it("rate limits repeated password change attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await changePasswordAction(undefined, makeForm("WrongPassword!", "NewPassword456!"));
    }
    const blocked = await changePasswordAction(undefined, makeForm("OldPassword123!", "NewPassword456!"));
    expect(blocked?.error).toMatch(/too many/i);
  });
});
