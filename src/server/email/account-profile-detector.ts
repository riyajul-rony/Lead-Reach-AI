import dns from "node:dns";
import { ImapFlow } from "imapflow";
import { db } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { logger } from "@/server/logger";
import {
  type AdaptiveAccountPlanType,
  type AdaptiveWorkspaceTier,
} from "@/server/email/adaptive-limit-config";

export interface MxRecordLike {
  exchange: string;
  priority: number;
}

export type ResolveMxFn = (domain: string) => Promise<MxRecordLike[]>;

export interface ImapMailboxEntryLike {
  path: string;
  specialUse?: string;
  flags?: Set<string> | string[];
}

export interface ImapFetchMessageLike {
  seq?: number;
  internalDate?: Date | string | null;
}

export interface ImapReadOnlyClientLike {
  connect(): Promise<void>;
  list(): Promise<ImapMailboxEntryLike[]>;
  getMailboxLock(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ release(): void }>;
  status(path: string, query: { messages?: boolean }): Promise<{ messages?: number }>;
  fetchAll?(
    range: string,
    query: { internalDate?: boolean }
  ): Promise<ImapFetchMessageLike[]>;
  fetch?(
    range: string,
    query: { internalDate?: boolean }
  ): AsyncIterable<ImapFetchMessageLike>;
  logout(): Promise<void>;
}

const DEFAULT_MX_TIMEOUT_MS = 4000;
const DEFAULT_IMAP_TIMEOUT_MS = 8000;

export async function resolveMxWithTimeout(
  domain: string,
  timeoutMs = DEFAULT_MX_TIMEOUT_MS,
  resolver: ResolveMxFn = (d) => dns.promises.resolveMx(d)
): Promise<MxRecordLike[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(domain),
      new Promise<MxRecordLike[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MX DNS lookup timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isGoogleMxHost(exchange: string): boolean {
  const host = exchange.toLowerCase().trim().replace(/\.$/, "");
  return (
    host === "google.com" ||
    host === "googlemail.com" ||
    host.endsWith(".google.com") ||
    host.endsWith(".googlemail.com")
  );
}

/**
 * Classifies an account address as free_gmail, Google Workspace (trial or paid via selector),
 * or fallback conservative workspace_trial for non-Google / DNS-failure domains.
 */
export async function detectEmailAccountType(params: {
  email: string;
  workspaceTier?: AdaptiveWorkspaceTier | string | null;
  resolveMxFn?: ResolveMxFn;
}): Promise<{
  accountType: AdaptiveAccountPlanType;
  isGoogleWorkspace: boolean;
  isNonGoogleOrUnknown: boolean;
  mxHosts: string[];
}> {
  const cleanEmail = params.email.toLowerCase().trim();
  const domain = cleanEmail.split("@")[1] || "";

  if (domain === "gmail.com" || domain === "googlemail.com") {
    return {
      accountType: "free_gmail",
      isGoogleWorkspace: false,
      isNonGoogleOrUnknown: false,
      mxHosts: [],
    };
  }

  if (!domain) {
    return {
      accountType: "workspace_trial",
      isGoogleWorkspace: false,
      isNonGoogleOrUnknown: true,
      mxHosts: [],
    };
  }

  try {
    const mxRecords = await resolveMxWithTimeout(
      domain,
      DEFAULT_MX_TIMEOUT_MS,
      params.resolveMxFn
    );
    const mxHosts = (mxRecords || [])
      .map((r) => String(r.exchange || "").toLowerCase().trim())
      .filter(Boolean);

    const hasGoogleMx = mxHosts.some((host) => isGoogleMxHost(host));
    if (hasGoogleMx) {
      const accountType: AdaptiveAccountPlanType =
        params.workspaceTier === "paid" ? "workspace_paid" : "workspace_trial";
      return {
        accountType,
        isGoogleWorkspace: true,
        isNonGoogleOrUnknown: false,
        mxHosts,
      };
    }

    return {
      accountType: "workspace_trial",
      isGoogleWorkspace: false,
      isNonGoogleOrUnknown: true,
      mxHosts,
    };
  } catch {
    return {
      accountType: "workspace_trial",
      isGoogleWorkspace: false,
      isNonGoogleOrUnknown: true,
      mxHosts: [],
    };
  }
}

/**
 * Finds the All Mail mailbox strictly via IMAP RFC 6154 `\All` special-use attribute.
 * Never hardcodes localized English or non-English folder names.
 */
export function findAllMailMailboxPath(mailboxes: ImapMailboxEntryLike[]): string | null {
  for (const box of mailboxes || []) {
    if (!box?.path) continue;
    const specialUse = (box.specialUse || "").trim().toLowerCase();
    if (specialUse === "\\all") {
      return box.path;
    }
    if (box.flags) {
      const flagArr = Array.isArray(box.flags) ? box.flags : Array.from(box.flags);
      if (flagArr.some((f) => String(f).trim().toLowerCase() === "\\all")) {
        return box.path;
      }
    }
  }
  return null;
}

export interface AgeDetectionResult {
  detectedAgeDays: number;
  messageCount: number;
  ageSource: "imap" | "fallback";
  warning?: string;
}

/**
 * Connects over IMAP read-only, locates the `\All` folder via LIST, and inspects ONLY
 * sequence `1:5` INTERNALDATE + total message count. Never reads subjects, bodies, or addresses.
 */
export async function detectAccountAgeViaImap(
  config: {
    host: string;
    port?: number;
    security?: string;
    username: string;
    password: string;
  },
  options?: {
    now?: Date;
    createClient?: () => ImapReadOnlyClientLike;
  }
): Promise<AgeDetectionResult> {
  const now = options?.now || new Date();
  if (!config.host || !config.username || !config.password) {
    return {
      detectedAgeDays: 0,
      messageCount: 0,
      ageSource: "fallback",
      warning: "Could not verify account age",
    };
  }

  const secure = config.security === "ssl" || Number(config.port || 993) === 993;
  const client: ImapReadOnlyClientLike = options?.createClient
    ? options.createClient()
    : (new ImapFlow({
        host: config.host.trim(),
        port: Number(config.port) || 993,
        secure,
        auth: {
          user: config.username.trim(),
          pass: config.password,
        },
        logger: false,
        connectionTimeout: 7000,
        greetingTimeout: 5000,
        tls: { rejectUnauthorized: false },
      }) as unknown as ImapReadOnlyClientLike);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async (): Promise<AgeDetectionResult> => {
      await client.connect();
      const boxes = await client.list();
      const allMailPath = findAllMailMailboxPath(boxes);
      if (!allMailPath) {
        return {
          detectedAgeDays: 0,
          messageCount: 0,
          ageSource: "fallback",
          warning: "Could not verify account age",
        };
      }

      const lock = await client.getMailboxLock(allMailPath, { readOnly: true });
      try {
        const st = await client.status(allMailPath, { messages: true });
        const messageCount = Math.max(0, Number(st?.messages) || 0);

        // Empty or almost-empty mailbox counts as a new account (<30 days)
        if (messageCount < 3) {
          return {
            detectedAgeDays: 0,
            messageCount,
            ageSource: "imap",
          };
        }

        const upperSeq = Math.min(5, messageCount);
        const range = `1:${upperSeq}`;
        const dates: Date[] = [];

        if (typeof client.fetch === "function") {
          for await (const msg of client.fetch(range, { internalDate: true })) {
            if (msg?.internalDate) {
              const d = new Date(msg.internalDate);
              if (!Number.isNaN(d.getTime())) dates.push(d);
            }
          }
        } else if (typeof client.fetchAll === "function") {
          const msgs = await client.fetchAll(range, { internalDate: true });
          for (const msg of msgs) {
            if (msg?.internalDate) {
              const d = new Date(msg.internalDate);
              if (!Number.isNaN(d.getTime())) dates.push(d);
            }
          }
        }

        if (dates.length === 0) {
          return {
            detectedAgeDays: 0,
            messageCount,
            ageSource: "fallback",
            warning: "Could not verify account age",
          };
        }

        const earliestMs = Math.min(...dates.map((d) => d.getTime()));
        const detectedAgeDays = Math.max(0, Math.floor((now.getTime() - earliestMs) / 86400000));
        return {
          detectedAgeDays,
          messageCount,
          ageSource: "imap",
        };
      } finally {
        lock.release();
      }
    };

    return await Promise.race([
      run(),
      new Promise<AgeDetectionResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("IMAP age check timeout")), DEFAULT_IMAP_TIMEOUT_MS);
      }),
    ]);
  } catch (err: any) {
    logger.warn({ err: err?.message, host: config.host }, "IMAP age detection fell back to new tier");
    return {
      detectedAgeDays: 0,
      messageCount: 0,
      ageSource: "fallback",
      warning: "Could not verify account age",
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.logout();
    } catch {}
  }
}

/**
 * Runs profile detection (type + IMAP metadata age) for an existing DB account.
 * Respects once-per-day automatic cadence unless `force === true`.
 * Re-detection never retroactively alters `start_limit_snapshot` once ramp has started.
 */
export async function runAccountProfileDetection(
  accountId: string,
  opts?: {
    force?: boolean;
    workspaceTier?: AdaptiveWorkspaceTier | string | null;
    now?: Date;
    resolveMxFn?: ResolveMxFn;
    createImapClient?: () => ImapReadOnlyClientLike;
  }
) {
  const account = await db.email_accounts.findUnique({ where: { id: accountId } });
  if (!account) {
    throw new Error("Email account not found");
  }

  const now = opts?.now || new Date();
  const lastDetectedMs = account.detected_at ? new Date(account.detected_at).getTime() : 0;
  const lessThanOneDay = lastDetectedMs > 0 && now.getTime() - lastDetectedMs < 24 * 3600 * 1000;
  if (!opts?.force && lessThanOneDay) {
    return {
      skipped: true,
      account,
      ageSource: (account.age_source || "fallback") as "imap" | "fallback",
      warning: account.age_source === "fallback" ? "Could not verify account age" : undefined,
    };
  }

  const effectiveTier =
    opts?.workspaceTier ??
    (account.workspace_tier === "paid" || account.account_type === "workspace_paid"
      ? "paid"
      : "trial");

  const typeInfo = await detectEmailAccountType({
    email: account.from_email,
    workspaceTier: effectiveTier,
    resolveMxFn: opts?.resolveMxFn,
  });

  let ageResult: AgeDetectionResult;
  if (typeInfo.isNonGoogleOrUnknown) {
    // Non-Google or undetectable domain gets the most conservative profile
    ageResult = {
      detectedAgeDays: 0,
      messageCount: account.message_count ?? 0,
      ageSource: "fallback",
      warning: "Could not verify account age",
    };
  } else {
    const imapPassword = account.imap_password_enc
      ? decrypt(account.imap_password_enc)
      : account.smtp_password_enc
        ? decrypt(account.smtp_password_enc)
        : "";
    if (!account.imap_host || !imapPassword) {
      ageResult = {
        detectedAgeDays: 0,
        messageCount: 0,
        ageSource: "fallback",
        warning: "Could not verify account age",
      };
    } else {
      ageResult = await detectAccountAgeViaImap(
        {
          host: account.imap_host,
          port: account.imap_port || 993,
          security: account.imap_security || "ssl",
          username: account.imap_username || account.from_email,
          password: imapPassword,
        },
        {
          now,
          createClient: opts?.createImapClient,
        }
      );
    }
  }

  const updateData: Record<string, any> = {
    account_type: typeInfo.accountType,
    workspace_tier: typeInfo.accountType === "free_gmail" ? null : effectiveTier,
    detected_age_days: ageResult.detectedAgeDays,
    message_count: ageResult.messageCount,
    age_source: ageResult.ageSource,
    detected_at: now,
  };

  // Re-detection must never retroactively change start_limit_snapshot for an active ramp
  const updated = await db.email_accounts.update({
    where: { id: accountId },
    data: updateData,
  });

  return {
    skipped: false,
    account: updated,
    ageSource: ageResult.ageSource,
    warning: ageResult.warning,
  };
}
