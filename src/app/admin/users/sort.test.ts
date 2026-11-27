import { describe, it, expect } from "vitest";
import { resolveAdminUsersSort } from "./sort";

describe("SEC-006 Admin Users Sort Allowlist", () => {
  it("falls back to created_at for disallowed or sensitive fields like password_hash", () => {
    expect(resolveAdminUsersSort("password_hash")).toBe("created_at");
    expect(resolveAdminUsersSort("__proto__")).toBe("created_at");
    expect(resolveAdminUsersSort("nonexistent_col")).toBe("created_at");
    expect(resolveAdminUsersSort(undefined)).toBe("created_at");
    expect(resolveAdminUsersSort("")).toBe("created_at");
  });

  it("allows valid user table sort fields", () => {
    expect(resolveAdminUsersSort("email")).toBe("email");
    expect(resolveAdminUsersSort("name")).toBe("name");
    expect(resolveAdminUsersSort("role")).toBe("role");
    expect(resolveAdminUsersSort("status")).toBe("status");
    expect(resolveAdminUsersSort("plan")).toBe("plan");
    expect(resolveAdminUsersSort("last_login_at")).toBe("last_login_at");
    expect(resolveAdminUsersSort("created_at")).toBe("created_at");
  });
});
