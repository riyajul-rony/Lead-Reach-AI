import { db } from "@/server/db";
import { verifyPassword } from "@/server/auth/password";
import { invalidateUserSessions } from "@/server/auth/session";
import { cancelUserJobs } from "@/server/queues/manager";
import { removeAvatar } from "@/server/storage/avatar";
import { logger } from "@/server/logger";

export class AccountActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountActionError";
    this.status = status;
  }
}

const SENSITIVE_KEY_PATTERN =
  /^(password_hash|password|smtp_password|imap_password|smtp_password_enc|imap_password_enc|oauth_access_token_enc|oauth_refresh_token_enc|access_token_enc|refresh_token_enc|key_enc|token_enc|token_hash|value_enc|api_secret|client_secret)$/i;

function sanitizeExportValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeExportValue);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k) || k.toLowerCase().endsWith("_enc")) {
        continue;
      }
      out[k] = sanitizeExportValue(v);
    }
    return out;
  }
  return value;
}

async function fetchPaginated<T extends { id?: string }>(
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  pageSize = 500,
  maxPages = 20
): Promise<T[]> {
  const results: T[] = [];
  const seenIds = new Set<string>();

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    const rows = await fetchPage(pageIdx * pageSize, pageSize);
    if (!Array.isArray(rows) || rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (row.id) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
      }
      results.push(row);
      added++;
    }

    if (rows.length < pageSize || added === 0) break;
  }

  return results;
}

/**
 * Exports all user-owned data in JSON format for GDPR portability,
 * strictly scoped to `userId` and omitting all credentials, password hashes, and tokens.
 */
export async function exportUserAccountData(userId: string) {
  const profile = await db.users.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      business_name: true,
      business_category: true,
      country: true,
      role: true,
      status: true,
      plan: true,
      timezone: true,
      sender_legal_name: true,
      sender_address: true,
      goals: true,
      email_verified_at: true,
      onboarded_at: true,
      last_login_at: true,
      created_at: true,
      updated_at: true,
    },
  });

  if (!profile) {
    throw new AccountActionError("Account not found", 404);
  }

  const [
    workspaces,
    oauthAccounts,
    emailAccounts,
    socialAccounts,
    googleConnections,
    apiKeys,
    leads,
    leadSearches,
    outreachCampaigns,
    campaignRecipients,
    emailMessages,
    suppressions,
    trackingDomains,
    subscriptions,
    payments,
  ] = await Promise.all([
    fetchPaginated((skip, take) =>
      db.workspaces.findMany({
        where: { user_id: userId },
        select: { id: true, name: true, is_default: true, business_address: true, created_at: true },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.oauth_accounts.findMany({
        where: { user_id: userId },
        select: { id: true, provider: true, provider_account_id: true, created_at: true },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.email_accounts.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          kind: true,
          provider: true,
          label: true,
          from_name: true,
          from_email: true,
          reply_to: true,
          signature: true,
          smtp_host: true,
          smtp_port: true,
          smtp_security: true,
          smtp_username: true,
          imap_host: true,
          imap_port: true,
          imap_security: true,
          imap_username: true,
          hourly_limit: true,
          daily_limit: true,
          gap_seconds: true,
          min_gap_seconds: true,
          max_gap_seconds: true,
          timezone: true,
          warmup_enabled: true,
          warmup_day: true,
          warmup_start_limit: true,
          warmup_daily_increment: true,
          warmup_max_limit: true,
          status: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.social_accounts.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          provider: true,
          external_id: true,
          display_name: true,
          status: true,
          scopes: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.google_connections.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          google_email: true,
          scopes: true,
          status: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.api_keys.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          provider: true,
          label: true,
          key_last4: true,
          status: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.leads.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          search_id: true,
          company_name: true,
          email: true,
          email_status: true,
          email_type: true,
          phone: true,
          website: true,
          address: true,
          city: true,
          state: true,
          country: true,
          postal_code: true,
          timezone: true,
          business_type: true,
          source: true,
          status: true,
          tags: true,
          notes: true,
          collected_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.lead_searches.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          source: true,
          provider_used: true,
          params: true,
          status: true,
          found_count: true,
          enriched_count: true,
          created_at: true,
          finished_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.outreach_campaigns.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          name: true,
          mode: true,
          status: true,
          recipient_source: true,
          subject_template: true,
          body_template: true,
          send_window: true,
          timezone: true,
          days_of_week: true,
          tracking_open: true,
          tracking_click: true,
          created_at: true,
          launched_at: true,
          completed_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.campaign_recipients.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          campaign_id: true,
          lead_id: true,
          email: true,
          name: true,
          company: true,
          status: true,
          current_step: true,
          sent_at: true,
          replied_at: true,
          open_count: true,
          click_count: true,
          reply_category: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.email_messages.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          recipient_id: true,
          email_account_id: true,
          direction: true,
          kind: true,
          step_no: true,
          subject: true,
          snippet: true,
          status: true,
          reply_category: true,
          sent_at: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.suppressions.findMany({
        where: { user_id: userId },
        select: { id: true, email: true, reason: true, created_at: true },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.tracking_domains.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          domain: true,
          cname_target: true,
          status: true,
          is_default: true,
          verified_at: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.subscriptions.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          plan_id: true,
          status: true,
          current_period_start: true,
          current_period_end: true,
          cancel_at_period_end: true,
          provider: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
    fetchPaginated((skip, take) =>
      db.payments.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          provider: true,
          invoice_number: true,
          paid_at: true,
          created_at: true,
        },
        skip,
        take,
      })
    ),
  ]);

  const campaignIds = outreachCampaigns.map((c: any) => c.id);
  const campaignSteps =
    campaignIds.length > 0 && db.campaign_steps?.findMany
      ? await fetchPaginated((skip, take) =>
          db.campaign_steps.findMany({
            where: { campaign_id: { in: campaignIds } },
            select: {
              id: true,
              campaign_id: true,
              step_no: true,
              delay_days: true,
              mode: true,
              tracking_open: true,
              tracking_click: true,
              created_at: true,
            },
            skip,
            take,
          })
        )
      : [];

  const rawExport = {
    exported_at: new Date().toISOString(),
    schema_version: "1.0",
    profile,
    workspaces,
    oauth_accounts: oauthAccounts,
    email_accounts: emailAccounts,
    social_accounts: socialAccounts,
    google_connections: googleConnections,
    api_keys: apiKeys,
    leads,
    lead_searches: leadSearches,
    outreach_campaigns: outreachCampaigns,
    campaign_steps: campaignSteps,
    campaign_recipients: campaignRecipients,
    email_messages: emailMessages,
    suppressions,
    tracking_domains: trackingDomains,
    subscriptions,
    payments,
  };

  return sanitizeExportValue(rawExport) as typeof rawExport;
}

/**
 * Permanently deletes the requesting user's account and all tenant data.
 * Requires password confirmation (or explicit DELETE confirmation for OAuth-only users).
 */
export async function deleteOwnAccount(
  userId: string,
  opts: { password?: string; confirmation?: string }
): Promise<{ deleted: true }> {
  const user = await db.users.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      password_hash: true,
      avatar_url: true,
    },
  });

  if (!user) {
    throw new AccountActionError("Account not found", 404);
  }

  if (user.role === "super_admin") {
    const activeSuperAdmins = await db.users.count({
      where: { role: "super_admin", status: "active" },
    });
    if (activeSuperAdmins <= 1) {
      throw new AccountActionError(
        "Cannot delete the last remaining active Super Admin account.",
        400
      );
    }
  }

  if (user.password_hash) {
    if (!opts.password || typeof opts.password !== "string") {
      throw new AccountActionError("Current password is required to delete your account.", 403);
    }
    const valid = await verifyPassword(user.password_hash, opts.password);
    if (!valid) {
      throw new AccountActionError("Incorrect password.", 403);
    }
  } else {
    const conf = (opts.confirmation || "").trim();
    const matchesDelete = conf.toUpperCase() === "DELETE";
    const matchesEmail = conf.toLowerCase() === String(user.email || "").toLowerCase();
    if (!matchesDelete && !matchesEmail) {
      throw new AccountActionError(
        'Please type "DELETE" (or your account email) to confirm account deletion.',
        400
      );
    }
  }

  // 1. Pause active campaigns and cancel queued background jobs
  await db.outreach_campaigns
    .updateMany({
      where: { user_id: userId, status: { in: ["running", "scheduled"] } },
      data: { status: "paused" },
    })
    .catch(() => null);

  await db.social_campaigns
    .updateMany({
      where: { user_id: userId, status: "active" },
      data: { status: "paused" },
    })
    .catch(() => null);

  await cancelUserJobs(userId).catch(() => null);
  await removeAvatar(user.avatar_url).catch(() => null);
  await invalidateUserSessions(userId).catch(() => null);

  // 2. Delete all user-owned data in FK-safe order (including Phase 3 tables)
  await db.$transaction(async (tx: any) => {
    const outreachCampaigns = await tx.outreach_campaigns.findMany({
      where: { user_id: userId },
      select: { id: true },
    });
    const outreachIds = outreachCampaigns.map((c: any) => c.id);

    const socialCampaigns = await tx.social_campaigns.findMany({
      where: { user_id: userId },
      select: { id: true },
    });
    const socialIds = socialCampaigns.map((c: any) => c.id);

    const sequences = await tx.followup_sequences.findMany({
      where: { user_id: userId },
      select: { id: true },
    });
    const sequenceIds = sequences.map((s: any) => s.id);

    await tx.warmup_logs.deleteMany({ where: { user_id: userId } });

    if (outreachIds.length > 0) {
      await tx.tracking_events.deleteMany({
        where: { campaign_id: { in: outreachIds } },
      });
    }

    await tx.email_messages.deleteMany({ where: { user_id: userId } });
    await tx.campaign_recipients.deleteMany({ where: { user_id: userId } });

    if (sequenceIds.length > 0) {
      await tx.followup_steps.deleteMany({
        where: { sequence_id: { in: sequenceIds } },
      });
    }
    await tx.followup_sequences.deleteMany({ where: { user_id: userId } });

    if (outreachIds.length > 0) {
      await tx.campaign_steps.deleteMany({
        where: { campaign_id: { in: outreachIds } },
      });
      await tx.campaign_variants.deleteMany({
        where: { campaign_id: { in: outreachIds } },
      });
      await tx.outreach_campaign_accounts.deleteMany({
        where: { campaign_id: { in: outreachIds } },
      });
    }

    await tx.outreach_campaigns.deleteMany({ where: { user_id: userId } });
    await tx.tracking_domains.deleteMany({ where: { user_id: userId } });

    await tx.post_runs.deleteMany({ where: { user_id: userId } });
    if (socialIds.length > 0) {
      await tx.campaign_reference_assets.deleteMany({
        where: { campaign_id: { in: socialIds } },
      });
    }
    await tx.social_campaigns.deleteMany({ where: { user_id: userId } });

    await tx.email_accounts.deleteMany({ where: { user_id: userId } });
    await tx.export_jobs.deleteMany({ where: { user_id: userId } });
    await tx.leads.deleteMany({ where: { user_id: userId } });
    await tx.lead_searches.deleteMany({ where: { user_id: userId } });
    await tx.suppressions.deleteMany({ where: { user_id: userId } });
    await tx.google_connections.deleteMany({ where: { user_id: userId } });
    await tx.social_accounts.deleteMany({ where: { user_id: userId } });
    await tx.api_keys.deleteMany({ where: { user_id: userId } });
    await tx.assets.deleteMany({ where: { user_id: userId } });

    await tx.payments.deleteMany({ where: { user_id: userId } });
    await tx.subscriptions.deleteMany({ where: { user_id: userId } });
    await tx.usage_counters.deleteMany({ where: { user_id: userId } });
    await tx.user_limit_overrides.deleteMany({ where: { user_id: userId } });

    await tx.notifications.deleteMany({ where: { user_id: userId } });
    await tx.activity_logs.deleteMany({ where: { user_id: userId } });
    await tx.admin_audit_logs.deleteMany({ where: { admin_id: userId } });
    await tx.apify_usage_logs.deleteMany({ where: { user_id: userId } });

    await tx.sessions.deleteMany({ where: { user_id: userId } });
    await tx.oauth_accounts.deleteMany({ where: { user_id: userId } });
    await tx.user_settings.deleteMany({ where: { user_id: userId } });
    await tx.workspaces.deleteMany({ where: { user_id: userId } });

    if (user.email) {
      await tx.verification_tokens.deleteMany({ where: { identifier: user.email } });
    }

    await tx.users.delete({ where: { id: userId } });
  });

  logger.info({ userId }, "GDPR self-service account deletion completed");
  return { deleted: true };
}
