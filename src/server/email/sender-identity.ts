export interface SenderIdentityLike {
  senderName?: string | null;
  from_name?: string | null;
  from_email?: string | null;
}

/**
 * Strips CR/LF and unsafe header control characters from a display name.
 */
export function sanitizeSenderName(rawName?: string | null): string {
  if (!rawName) return "";
  return rawName
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .trim();
}

/**
 * Resolves the editable sender name from account identity fields.
 */
export function resolveAccountSenderName(
  account?: SenderIdentityLike | null,
  fallbackName?: string | null
): string {
  const explicit = sanitizeSenderName(account?.senderName ?? account?.from_name);
  if (explicit) return explicit;
  return sanitizeSenderName(fallbackName);
}

/**
 * Extracts the sender's first name for {{sender_first_name}}.
 * Example: "Alex Carter" -> "Alex". Returns "" when no sender name is set.
 */
export function resolveSenderFirstName(
  accountOrName?: SenderIdentityLike | string | null
): string {
  const raw =
    typeof accountOrName === "string"
      ? sanitizeSenderName(accountOrName)
      : resolveAccountSenderName(accountOrName);
  if (!raw) return "";
  return raw.split(/\s+/)[0] || "";
}

/**
 * Composes an RFC 2822 From header string from senderName + from_email.
 * Never falls back to product branding; omits quotes/name cleanly when empty.
 */
export function formatFromHeader(
  account: SenderIdentityLike & { from_email: string },
  fallbackName?: string | null
): string {
  const name = resolveAccountSenderName(account, fallbackName);
  const email = account.from_email.trim();
  return name ? `"${name}" <${email}>` : email;
}
