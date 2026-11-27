const ALLOWED_USER_SORTS = new Set([
  "created_at",
  "email",
  "name",
  "role",
  "status",
  "plan",
  "last_login_at",
  "email_verified_at",
]);

export function resolveAdminUsersSort(raw?: string | null): string {
  if (typeof raw === "string" && ALLOWED_USER_SORTS.has(raw)) {
    return raw;
  }
  return "created_at";
}
