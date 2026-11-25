import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { decrypt } from "@/server/crypto";
import { getDecryptedAccountCredentials, getEffectiveAccountDailyLimit } from "@/server/email/account-service";
import { ensureFreshGoogleAccessToken, sendViaGmailApi } from "@/server/email/google-oauth";
import { getUserApiKey } from "@/server/api-keys/service";
import { renderEmailTemplate } from "@/server/email/template-renderer";
import { generateOutreachEmail } from "@/server/ai/outreach-generator";
import { assertLimit } from "@/server/billing/limits";
import { trackUsageIncrement } from "@/server/billing/usage-tracker";
import { queueEmailSend } from "@/server/queues";
import { createSignedTrackingToken } from "@/server/email/tracking-token";

const BASE_URL = process.env.NEXTAUTH_URL || process.env.APP_URL || "http://localhost:3000";

export interface SendingWindowOptions {
  timezone?: string | null;
  startHour?: number | null;
  endHour?: number | null;
  daysOfWeek?: number[] | null;
}

/**
 * Constructs strict multipart/alternative email bodies:
 * - text: Pure plaintext without raw HTML tags or tracking pixels.
 * - html: Semantic HTML carrying the open tracking pixel and a styled unsubscribe link.
 */
export function buildEmailMultipartBodies(opts: {
  bodyText: string;
  legalAddress: string;
  unsubscribeUrl: string;
  trackingOpen?: boolean;
  trackingClick?: boolean;
  unsubscribeToken: string;
  baseUrl: string;
}): { text: string; html: string } {
  // 1. Clean plain-text body (strictly NO HTML tags or tracking pixels, raw URLs untouched)
  const text = `${opts.bodyText}\n\n---\n${opts.legalAddress}\nTo unsubscribe: ${opts.unsubscribeUrl}`;

  // Helper to escape HTML characters safely
  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  // 2. Formatted HTML body with conditional click-tracking link wrapping
  const formattedHtmlParagraphs = opts.bodyText
    .split(/\r?\n\r?\n/)
    .map((para) => {
      const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
      let lastIndex = 0;
      let htmlPara = "";
      let match: RegExpExecArray | null;

      while ((match = urlRegex.exec(para)) !== null) {
        const rawUrl = match[0];
        const matchStart = match.index;
        htmlPara += escapeHtml(para.slice(lastIndex, matchStart)).replace(/\r?\n/g, "<br />");
        lastIndex = matchStart + rawUrl.length;

        // Unsubscribe links are NEVER wrapped with click tracking
        const isUnsubLink =
          rawUrl === opts.unsubscribeUrl ||
          rawUrl.includes("/api/v1/unsubscribe/") ||
          rawUrl.includes("/unsubscribe/");

        if (isUnsubLink || !opts.trackingClick) {
          htmlPara += `<a href="${escapeHtml(rawUrl)}" style="color: #0284c7; text-decoration: underline;">${escapeHtml(rawUrl)}</a>`;
        } else {
          // Wrap destination securely via HMAC-signed token
          const signedToken = createSignedTrackingToken(opts.unsubscribeToken, rawUrl);
          const clickUrl = `${opts.baseUrl}/api/v1/track/click/${signedToken}`;
          htmlPara += `<a href="${clickUrl}" style="color: #0284c7; text-decoration: underline;">${escapeHtml(rawUrl)}</a>`;
        }
      }

      htmlPara += escapeHtml(para.slice(lastIndex)).replace(/\r?\n/g, "<br />");
      return `<p style="margin: 0 0 16px 0; line-height: 1.6;">${htmlPara}</p>`;
    })
    .join("");

  const escapedAddress = escapeHtml(opts.legalAddress).replace(/\r?\n/g, "<br />");

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #1e293b; background-color: #ffffff;">
  <div>
    ${formattedHtmlParagraphs}
  </div>
  <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
    <p style="margin: 0 0 8px 0;">${escapedAddress}</p>
    <p style="margin: 0;"><a href="${opts.unsubscribeUrl}" style="color: #64748b; text-decoration: underline;">Unsubscribe</a></p>
  </div>
`;

  if (opts.trackingOpen) {
    html += `  <img src="${opts.baseUrl}/api/v1/track/open/${opts.unsubscribeToken}" width="1" height="1" style="display:none !important;" alt="" />\n`;
  }

  html += `</body>
</html>`;

  return { text, html };
}

/**
 * Parses local date/time components (weekday, hour, minute) in an IANA timezone with UTC fallback.
 */
export function getLocalTimeParts(
  date: Date,
  timezone = "UTC"
): { weekdayNum: number; hour: number; minute: number } {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(date);
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value || "Mon";
    const hourStr = parts.find((p) => p.type === "hour")?.value || "0";
    const minuteStr = parts.find((p) => p.type === "minute")?.value || "0";

    const dayMap: Record<string, number> = {
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
      Sun: 7,
    };
    const weekdayNum = dayMap[weekdayStr] || 1;
    const rawHour = parseInt(hourStr, 10);
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = parseInt(minuteStr, 10) || 0;

    return { weekdayNum, hour, minute };
  } catch {
    const day = date.getUTCDay();
    return {
      weekdayNum: day === 0 ? 7 : day,
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
}

/**
 * Checks whether the current time falls inside the campaign's active days and working hours.
 */
export function isWithinSendingWindow(date: Date, options: SendingWindowOptions): boolean {
  const { weekdayNum, hour } = getLocalTimeParts(date, options.timezone || "UTC");

  const activeDays =
    options.daysOfWeek && options.daysOfWeek.length > 0 ? options.daysOfWeek : [1, 2, 3, 4, 5];

  // Match 1..7 or 0 (0 and 7 both represent Sunday)
  const isDayAllowed = activeDays.some((d) => d === weekdayNum || (weekdayNum === 7 && d === 0));
  if (!isDayAllowed) {
    return false;
  }

  const start = options.startHour !== undefined && options.startHour !== null ? options.startHour : 9;
  const end = options.endHour !== undefined && options.endHour !== null ? options.endHour : 18;

  return hour >= start && hour < end;
}

/**
 * Calculates a randomized jitter delay in seconds to protect sender domain reputation.
 */
export function calculateRandomJitterSec(minSec = 60, maxSec = 180): number {
  const min = Math.max(0, Math.floor(minSec));
  const max = Math.max(min, Math.floor(maxSec));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Rotates and selects the next available, least-loaded sender account for a campaign.
 * Enforces both the 25/hr hard cap and dynamic daily warm-up limits.
 */
export async function selectAvailableAccountForCampaign(campaignId: string, userId: string) {
  // 1. Fetch connected campaign accounts
  let accountIds: string[] = [];
  try {
    const links = await db.outreach_campaign_accounts.findMany({
      where: { campaign_id: campaignId },
      select: { email_account_id: true },
    });
    accountIds = links.map((l: any) => l.email_account_id);
  } catch {}

  if (accountIds.length === 0) {
    const campaign = await db.outreach_campaigns.findFirst({
      where: { id: campaignId },
      select: { source_ref: true },
    });
    accountIds = (campaign?.source_ref as any)?.sender_account_ids || [];
  }

  const whereClause: any = { user_id: userId, status: "active" };
  if (accountIds.length > 0) {
    whereClause.id = { in: accountIds };
  }

  const candidateAccounts = await db.email_accounts.findMany({
    where: whereClause,
  });

  if (candidateAccounts.length === 0) {
    return { account: null, throttled: false, reason: "No active sender accounts found for campaign" };
  }

  const now = new Date();
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const evaluatedAccounts: Array<{
    account: any;
    sentLastHour: number;
    sentToday: number;
    hourlyCap: number;
    dailyCap: number;
    availableCapacity: number;
  }> = [];

  for (const account of candidateAccounts) {
    let sentLastHour = 0;
    let sentToday = 0;
    try {
      if (db.email_messages?.count) {
        sentLastHour = await db.email_messages.count({
          where: {
            email_account_id: account.id,
            sent_at: { gte: sixtyMinutesAgo },
            status: "sent",
          },
        });
        sentToday = await db.email_messages.count({
          where: {
            email_account_id: account.id,
            sent_at: { gte: startOfDay },
            status: "sent",
          },
        });
      }
    } catch {}

    const hourlyCap = Math.min(account.hourly_limit || 25, 25);
    const dailyCap = getEffectiveAccountDailyLimit(account);

    const isHourlyThrottled = sentLastHour >= hourlyCap;
    const isDailyThrottled = sentToday >= dailyCap;
    const isWaitGapActive = Boolean(account.next_allowed_at && new Date(account.next_allowed_at) > now);

    if (!isHourlyThrottled && !isDailyThrottled && !isWaitGapActive) {
      evaluatedAccounts.push({
        account,
        sentLastHour,
        sentToday,
        hourlyCap,
        dailyCap,
        availableCapacity: Math.min(hourlyCap - sentLastHour, dailyCap - sentToday),
      });
    }
  }

  if (evaluatedAccounts.length === 0) {
    return {
      account: null,
      throttled: true,
      reason: "All assigned sender accounts have reached their hourly (25/hr) or daily warmup limit",
    };
  }

  // Select least loaded account (fewest sends in the last hour)
  evaluatedAccounts.sort((a, b) => a.sentLastHour - b.sentLastHour);
  return { account: evaluatedAccounts[0].account, throttled: false };
}

export interface DispatchTransportInput {
  account: {
    id: string;
    provider: string;
    from_name?: string | null;
    from_email: string;
    reply_to?: string | null;
    reply_inbox_account_id?: string | null;
  };
  to: string;
  subject: string;
  text: string;
  html: string;
  explicitMessageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  headers?: Record<string, string>;
}

/**
 * Shared email transport: routes through Gmail API or validated external SMTP.
 * Enforces explicit RFC Message-ID and threading headers for both send paths.
 */
export async function dispatchEmailTransport(
  input: DispatchTransportInput
): Promise<{ messageId: string }> {
  const {
    account,
    to,
    subject,
    text,
    html,
    explicitMessageId,
    inReplyTo,
    references,
    headers = {},
  } = input;

  // Resolve effective Reply-To header: account.reply_to -> linked reply_inbox -> account.from_email
  let effectiveReplyTo = account.reply_to?.trim() || "";
  if (!effectiveReplyTo && account.reply_inbox_account_id) {
    try {
      const linkedInbox = await db.email_accounts.findUnique({
        where: { id: account.reply_inbox_account_id },
        select: { from_email: true },
      });
      if (linkedInbox?.from_email) {
        effectiveReplyTo = linkedInbox.from_email.trim();
      }
    } catch {}
  }
  if (!effectiveReplyTo) {
    effectiveReplyTo = account.from_email;
  }

  const mergedHeaders: Record<string, string> = {
    ...headers,
    "Message-ID": explicitMessageId,
  };
  if (inReplyTo) {
    mergedHeaders["In-Reply-To"] = inReplyTo;
    mergedHeaders["References"] = references || inReplyTo;
  }

  if (account.provider === "gmail_api") {
    const accessToken = await ensureFreshGoogleAccessToken(account.id);
    const fromAddr = account.from_name
      ? `"${account.from_name}" <${account.from_email}>`
      : account.from_email;

    const result = await sendViaGmailApi(accessToken, {
      from: fromAddr,
      to,
      replyTo: effectiveReplyTo,
      subject,
      text,
      html,
      messageId: explicitMessageId,
      inReplyTo: inReplyTo || undefined,
      references: (references || inReplyTo) || undefined,
      headers: mergedHeaders,
    });
    return { messageId: result.messageId || explicitMessageId };
  } else {
    // SMTP transport
    const creds = await getDecryptedAccountCredentials(account.id);
    if (!creds || !creds.smtp_host) {
      throw new Error("Invalid SMTP credentials for account");
    }

    const transport = nodemailer.createTransport({
      host: creds.smtp_host,
      port: creds.smtp_port || 587,
      secure: creds.smtp_security === "ssl" || creds.smtp_port === 465,
      auth: {
        user: creds.smtp_username || account.from_email,
        pass: creds.smtp_password,
      },
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 10000,
    });

    try {
      await transport.sendMail({
        from: `"${account.from_name || account.from_email}" <${account.from_email}>`,
        to,
        replyTo: effectiveReplyTo,
        subject,
        text,
        html,
        messageId: explicitMessageId,
        headers: mergedHeaders,
      });
      return { messageId: explicitMessageId };
    } finally {
      if (transport && typeof transport.close === "function") {
        transport.close();
      }
    }
  }
}

/**
 * Sends a single email to a recipient, observing rate limits, headers, suppressions,
 * dual dispatch (Gmail REST API vs SMTP), and threading.
 */
export async function sendSingleRecipientEmail(recipientId: string) {
  const recipient = await db.campaign_recipients.findFirst({
    where: { id: recipientId },
  });

  if (!recipient || recipient.status !== "queued") {
    return {
      skipped: true,
      reason: recipient
        ? `Recipient status is '${recipient.status}' (only 'queued' can be dispatched)`
        : "Recipient not found",
    };
  }

  const campaign = await db.outreach_campaigns.findFirst({
    where: { id: recipient.campaign_id },
  });

  if (!campaign || campaign.status !== "running") {
    return { skipped: true, reason: "Campaign is not running" };
  }

  // Check plan limits (monthly and daily outreach quotas)
  try {
    await assertLimit(recipient.user_id, "monthly_outreach_emails", 1);
    await assertLimit(recipient.user_id, "daily_outreach_emails", 1);
  } catch (err: any) {
    logger.warn({ recipientId, userId: recipient.user_id, err: err.message }, "Outreach quota exceeded");
    return { skipped: true, reason: err.message };
  }

  // 1. Double check suppression
  const suppression = await db.suppressions.findFirst({
    where: { user_id: recipient.user_id, email: recipient.email.toLowerCase() },
  });

  if (suppression) {
    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: { status: "unsubscribed", error: "Suppression match" },
    });
    return { skipped: true, reason: "Suppressed" };
  }

  // 2. Resolve sender account
  let account: any = null;
  if (recipient.assigned_account_id) {
    account = await db.email_accounts.findFirst({
      where: { id: recipient.assigned_account_id },
    });
  }

  if (!account || account.status !== "active") {
    const selection = await selectAvailableAccountForCampaign(campaign.id, recipient.user_id);
    if (!selection.account) {
      return { throttled: selection.throttled, reason: selection.reason || "No available sender account" };
    }
    account = selection.account;

    // Update recipient assignment
    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: { assigned_account_id: account.id },
    });
  }

  // Verify rate limit on resolved account
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  const sentLastHour = await db.email_messages.count({
    where: {
      email_account_id: account.id,
      sent_at: { gte: sixtyMinutesAgo },
      status: "sent",
    },
  });

  const hourlyCap = Math.min(account.hourly_limit || 25, 25);
  if (sentLastHour >= hourlyCap) {
    logger.warn({ accountId: account.id, sentLastHour, hourlyCap }, "Account reached hourly cap of 25");
    return { throttled: true, reason: "Hourly limit reached" };
  }

  const dailyCap = getEffectiveAccountDailyLimit(account);
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
  const sentToday = await db.email_messages.count({
    where: {
      email_account_id: account.id,
      sent_at: { gte: startOfDay },
      status: "sent",
    },
  });

  if (sentToday >= dailyCap) {
    logger.warn({ accountId: account.id, sentToday, dailyCap }, "Account reached daily warmup limit");
    return { throttled: true, reason: "Daily warmup limit reached" };
  }

  // Check per-account wait gap cooldown
  if (account.next_allowed_at && new Date(account.next_allowed_at) > new Date()) {
    const cooldownMs = new Date(account.next_allowed_at).getTime() - Date.now();
    const cooldownSec = Math.ceil(cooldownMs / 1000);
    logger.warn({ accountId: account.id, cooldownSec }, "Account wait gap cooldown active");
    return { throttled: true, reason: `Account wait gap active (cooldown: ${cooldownSec}s remaining)` };
  }

  const currentStep = recipient.current_step || 0;

  // Never resend initial email if recipient already has sent metadata
  if (currentStep === 0 && (recipient.sent_at || recipient.last_sent_at || recipient.thread_message_id)) {
    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: { status: "sent" },
    }).catch(() => null);
    return { skipped: true, reason: "Initial email already sent" };
  }

  // Idempotency guard: check if this exact step was already recorded as sent
  try {
    const alreadySentStep = await db.email_messages.findFirst({
      where: {
        recipient_id: recipient.id,
        direction: "out",
        kind: currentStep === 0 ? "initial" : "followup",
        step_no: currentStep,
        status: "sent",
      },
    });
    if (alreadySentStep) {
      await db.campaign_recipients.update({
        where: { id: recipient.id },
        data: { status: "sent" },
      }).catch(() => null);
      return { skipped: true, reason: `Step ${currentStep} already sent` };
    }
  } catch {}

  // 3. Atomically claim recipient ('queued' -> 'sending') so concurrent or retried workers cannot double-send
  const claimed = await db.campaign_recipients.updateMany({
    where: { id: recipient.id, status: "queued" },
    data: { status: "sending", sending_started_at: new Date() },
  });
  if (!claimed || claimed.count === 0) {
    return { skipped: true, reason: "Recipient already claimed or no longer queued" };
  }

  const unsubscribeUrl = `${BASE_URL}/u/${recipient.unsubscribe_token}`;
  const legalAddress =
    (campaign.source_ref as any)?.sender_address_footer ||
    account.signature ||
    "Lead Reach AI Verified Cold Outreach, Cerkit Labs";

  let finalSubject = "";
  let finalBody = "";
  let isThreadedFollowup = false;
  let inReplyToId: string | undefined = undefined;
  let transportAcceptedMessageId: string | null = null;

  try {
    // 4. Generate content for initial outreach or follow-up step
    if (currentStep === 0) {
      // Step 0: Initial Outreach
      if (campaign.mode === "ai") {
        let rawApiKey = "";
        if (campaign.openai_key_id) {
          const keyRecord = await db.api_keys.findFirst({
            where: { id: campaign.openai_key_id, user_id: recipient.user_id },
          });
          if (keyRecord?.key_enc) {
            try {
              rawApiKey = decrypt(keyRecord.key_enc);
            } catch {}
          }
        }
        if (!rawApiKey) {
          rawApiKey = (await getUserApiKey(recipient.user_id, "openai")) || "";
        }

        if (rawApiKey) {
          const generated = await generateOutreachEmail({
            apiKey: rawApiKey,
            senderName: account.from_name,
            recipientName: recipient.name || undefined,
            recipientCompany: recipient.company || undefined,
            recipientWebsite: (recipient.vars as any)?.website || undefined,
            goalOrOffer: (campaign.ai_config as any)?.goalOrOffer,
            tone: (campaign.ai_config as any)?.tone,
            textModel: campaign.text_model || (campaign.ai_config as any)?.textModel,
          });
          finalSubject = generated.subject;
          finalBody = generated.body;
        } else {
          finalSubject = renderEmailTemplate(
            campaign.subject_template || "Quick question for {{company_name|your business}}",
            (recipient.vars as any) || {}
          );
          finalBody = renderEmailTemplate(
            campaign.body_template || "Hi {{first_name|there}},\n\nWould love to connect.",
            (recipient.vars as any) || {}
          );
        }
      } else {
        finalSubject = renderEmailTemplate(
          campaign.subject_template || "Hello {{company_name|there}}",
          (recipient.vars as any) || {},
          unsubscribeUrl
        );
        finalBody = renderEmailTemplate(
          campaign.body_template || "Hi {{first_name|there}},\n\nWould love to connect.",
          (recipient.vars as any) || {},
          unsubscribeUrl
        );
      }
    } else {
      // Follow-up step (> 0)
      let stepRecord: any = null;
      try {
        if (db.campaign_steps?.findFirst) {
          stepRecord = await db.campaign_steps.findFirst({
            where: { campaign_id: campaign.id, step_no: currentStep },
          });
        }
      } catch {}

      const previousSubject = recipient.generated_subject || campaign.subject_template || "Our conversation";
      const subjectTpl =
        stepRecord?.subject_template ||
        `Re: ${previousSubject.replace(/^Re:\s*/i, "")}`;

      finalSubject = renderEmailTemplate(
        subjectTpl,
        {
          previous_subject: previousSubject,
          ...((recipient.vars as any) || {}),
        },
        unsubscribeUrl
      );

      finalBody = renderEmailTemplate(
        stepRecord?.body_template || "Following up on my previous note. Let me know if you have 5 minutes to chat.",
        (recipient.vars as any) || {},
        unsubscribeUrl
      );

      if (recipient.thread_message_id) {
        isThreadedFollowup = true;
        inReplyToId = recipient.thread_message_id;
      }
    }

    // Construct clean multipart/alternative bodies (pure plain-text + semantic HTML)
    const { text: plainTextBody, html: htmlBody } = buildEmailMultipartBodies({
      bodyText: finalBody,
      legalAddress,
      unsubscribeUrl,
      trackingOpen: Boolean(campaign.tracking_open),
      trackingClick: Boolean(campaign.tracking_click),
      unsubscribeToken: recipient.unsubscribe_token,
      baseUrl: BASE_URL,
    });

    // Generate explicit RFC Message-ID
    const senderDomain = account.from_email.split("@")[1] || "leadreach.ai";
    const explicitMessageId = `<${crypto.randomUUID()}@${senderDomain}>`;

    const transportResult = await dispatchEmailTransport({
      account,
      to: recipient.email,
      subject: finalSubject,
      text: plainTextBody,
      html: htmlBody,
      explicitMessageId,
      inReplyTo: inReplyToId,
      references: inReplyToId,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-LeadReachAI-Campaign-Id": campaign.id,
        "X-LeadReachAI-Recipient-Id": recipient.id,
      },
    });

    const messageId = transportResult.messageId;
    transportAcceptedMessageId = messageId;

    // 6. Record message in database
    await db.email_messages.create({
      data: {
        user_id: recipient.user_id,
        recipient_id: recipient.id,
        email_account_id: account.id,
        direction: "out",
        kind: currentStep === 0 ? "initial" : "followup",
        step_no: currentStep,
        message_id: messageId,
        subject: finalSubject,
        snippet: finalBody.slice(0, 150),
        status: "sent",
        sent_at: new Date(),
      },
    });

    // 7. Calculate next follow-up date if further steps exist
    let nextFollowupAt: Date | null = null;
    try {
      if (db.campaign_steps?.findFirst) {
        const nextStep = await db.campaign_steps.findFirst({
          where: { campaign_id: campaign.id, step_no: currentStep + 1 },
        });
        if (nextStep) {
          const delayDays = nextStep.delay_days || 3;
          nextFollowupAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
        }
      }
    } catch {}

    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: {
        status: "sent",
        sent_at: new Date(),
        last_sent_at: new Date(),
        generated_subject: finalSubject,
        generated_body: finalBody,
        thread_message_id: recipient.thread_message_id || messageId,
        current_step: currentStep + 1,
        next_followup_at: nextFollowupAt,
        attempts: (recipient.attempts || 0) + 1,
        error: null,
      },
    });

    // Update account's next_allowed_at with randomized wait gap (min_gap_seconds to max_gap_seconds)
    const minGap = Math.max(Number(account.min_gap_seconds) || Number(account.gap_seconds) || 180, 30);
    const maxGap = Math.max(Number(account.max_gap_seconds) || minGap * 2 || 420, minGap);
    const gapSec = calculateRandomJitterSec(minGap, maxGap);
    const nextAllowed = new Date(Date.now() + gapSec * 1000);

    try {
      await db.email_accounts.update({
        where: { id: account.id },
        data: { next_allowed_at: nextAllowed },
      });
    } catch {}

    logger.info(
      { recipientId: recipient.id, email: recipient.email, messageId, step: currentStep, gapSec },
      "Outreach email dispatched successfully"
    );

    trackUsageIncrement(recipient.user_id, "monthly_outreach_emails", 1).catch(() => null);

    return { success: true, messageId };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Failed to send email";
    logger.error({ err, recipientId: recipient.id }, "Failed to send outreach email");

    // Check for critical authentication / credentials failure
    const isAuthFailure =
      errorMsg.includes("EAUTH") ||
      errorMsg.includes("BadCredentials") ||
      errorMsg.includes("535") ||
      errorMsg.includes("reconnection required") ||
      errorMsg.includes("invalid_grant") ||
      errorMsg.includes("Token has been expired or revoked");

    if (isAuthFailure && account) {
      await db.email_accounts.update({
        where: { id: account.id },
        data: {
          status: "needs_attention",
          last_error: errorMsg,
        },
      });

      // Pause campaign for safety
      await db.outreach_campaigns.update({
        where: { id: campaign.id },
        data: { status: "paused" },
      });
      logger.warn({ accountId: account.id, campaignId: campaign.id }, "Sender account requires attention, campaign paused");
    }

    if (transportAcceptedMessageId) {
      // Partial failure: mail server accepted the message, but DB persistence failed.
      // Mark as needs_review (never failed/queued) so it is never auto-resent.
      await db.campaign_recipients.update({
        where: { id: recipient.id },
        data: {
          status: "needs_review",
          thread_message_id: recipient.thread_message_id || transportAcceptedMessageId,
          attempts: (recipient.attempts || 0) + 1,
          error: `Email accepted by transport (${transportAcceptedMessageId}) but DB update failed: ${errorMsg}. Do not auto-resend without verifying Sent folder.`,
        },
      }).catch(() => null);

      return { success: false, partialFailure: true, messageId: transportAcceptedMessageId, error: errorMsg };
    }

    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: {
        status: "failed",
        attempts: (recipient.attempts || 0) + 1,
        error: errorMsg,
      },
    });

    return { success: false, error: errorMsg };
  }
}

/**
 * Safely recovers recipients left in 'sending' state after a worker crash.
 * Marks them 'needs_review' after STUCK_SENDING_MINUTES (default 15m) — never auto-resends.
 */
export async function recoverStuckSendingRecipients(
  campaignId?: string,
  now: Date = new Date()
): Promise<number> {
  const rawMinutes = Number(process.env.STUCK_SENDING_MINUTES);
  const stuckMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 15;
  const stuckCutoff = new Date(now.getTime() - stuckMinutes * 60 * 1000);

  try {
    const whereClause: any = {
      status: "sending",
      sending_started_at: { lt: stuckCutoff },
    };
    if (campaignId) {
      whereClause.campaign_id = campaignId;
    }

    const res = await db.campaign_recipients.updateMany({
      where: whereClause,
      data: {
        status: "needs_review",
        error: `Recipient stayed in 'sending' for over ${stuckMinutes}m (possible worker crash). Marked as needs_review; never auto-resend.`,
      },
    });

    if (res.count > 0) {
      logger.warn(
        { campaignId, count: res.count, stuckMinutes, stuckCutoff: stuckCutoff.toISOString() },
        "Stuck sending recovery: Marked crashed 'sending' recipients as needs_review"
      );
    }
    return res.count;
  } catch (err) {
    logger.error({ err, campaignId }, "Failed to recover stuck 'sending' recipients");
    return 0;
  }
}

/**
 * Periodic dispatch loop: Finds running campaigns, validates sending window,
 * applies randomized jitter, and schedules emails through BullMQ.
 */
export async function dispatchRunningCampaigns(): Promise<{ dispatched: number; throttled: number; scheduled: number }> {
  const runningCampaigns = await db.outreach_campaigns.findMany({
    where: { status: "running" },
  });

  let totalDispatched = 0;
  let totalThrottled = 0;
  let totalScheduled = 0;

  const now = new Date();

  for (const campaign of runningCampaigns) {
    try {
      // 0. Recover any recipients stuck in 'sending' after a worker crash (marks needs_review, never auto-resends)
      await recoverStuckSendingRecipients(campaign.id, now);

      // 1. Check Sending Window & Working Days
      const windowStart = (campaign.send_window as any)?.startHour ?? 9;
      const windowEnd = (campaign.send_window as any)?.endHour ?? 18;
      const daysOfWeek = campaign.days_of_week && campaign.days_of_week.length > 0
        ? campaign.days_of_week
        : [1, 2, 3, 4, 5];

      const inWindow = isWithinSendingWindow(now, {
        timezone: campaign.timezone || "UTC",
        startHour: windowStart,
        endHour: windowEnd,
        daysOfWeek,
      });

      if (!inWindow) {
        continue; // Outside active window, will resume on next cycle
      }

      // 2. Stale catch-up protection: Mark queued recipients older than stale threshold as needs_review
      const staleHours = Number(process.env.STALE_THRESHOLD_HOURS) || 24;
      const staleCutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      try {
        const staleQueued = await db.campaign_recipients.updateMany({
          where: {
            campaign_id: campaign.id,
            status: "queued",
            created_at: { lt: staleCutoff },
          },
          data: {
            status: "needs_review",
            error: `Campaign queued email is older than stale threshold (${staleHours}h). Requires review before dispatch.`,
          },
        });
        if (staleQueued.count > 0) {
          logger.warn(
            { campaignId: campaign.id, count: staleQueued.count },
            "Catch-up protection: Marked overdue queued recipients as needs_review"
          );
        }
      } catch (err) {
        logger.error({ err, campaignId: campaign.id }, "Failed to apply catch-up protection to queued recipients");
      }

      // Fetch candidate queued recipients within safe threshold
      const queuedRecipients = await db.campaign_recipients.findMany({
        where: {
          campaign_id: campaign.id,
          status: "queued",
          created_at: { gte: staleCutoff },
        },
        take: 20,
      });

      if (queuedRecipients.length === 0) {
        // Check if all recipients have finished
        const pending = await db.campaign_recipients.count({
          where: { campaign_id: campaign.id, status: { in: ["queued", "sending"] } },
        });

        if (pending === 0) {
          // Check if any followups are still scheduled
          const scheduledFollowups = await db.campaign_recipients.count({
            where: { campaign_id: campaign.id, next_followup_at: { not: null } },
          });

          if (scheduledFollowups === 0) {
            await db.outreach_campaigns.update({
              where: { id: campaign.id },
              data: { status: "completed", completed_at: new Date() },
            });
            logger.info({ campaignId: campaign.id }, "Campaign completed all steps");
          }
        }
        continue;
      }

      // 3. Dispatch batch with randomized jitter and per-account wait gaps
      let cumulativeDelayMs = 0;
      for (const rec of queuedRecipients) {
        let accountMinGap = campaign.jitter_min_sec || 60;
        let accountMaxGap = campaign.jitter_max_sec || 180;
        let accountCooldownMs = 0;

        if (rec.assigned_account_id) {
          try {
            const acc = await db.email_accounts.findUnique({
              where: { id: rec.assigned_account_id },
              select: { next_allowed_at: true, min_gap_seconds: true, max_gap_seconds: true, gap_seconds: true },
            });
            if (acc) {
              if (acc.min_gap_seconds) accountMinGap = acc.min_gap_seconds;
              if (acc.max_gap_seconds) accountMaxGap = acc.max_gap_seconds;
              if (acc.next_allowed_at && new Date(acc.next_allowed_at) > new Date()) {
                accountCooldownMs = new Date(acc.next_allowed_at).getTime() - Date.now();
              }
            }
          } catch {}
        }

        const jitterSec = calculateRandomJitterSec(accountMinGap, accountMaxGap);
        cumulativeDelayMs += jitterSec * 1000;
        const totalDelayMs = Math.max(cumulativeDelayMs, accountCooldownMs);

        // Queue in BullMQ if available
        const enqueued = await queueEmailSend(rec.id, totalDelayMs);
        if (enqueued) {
          totalScheduled++;
        } else {
          // If offline and account cooldown is active, mark throttled
          if (accountCooldownMs > 0) {
            totalThrottled++;
            continue;
          }

          // Fallback direct execution if Redis queue is offline
          const result = await sendSingleRecipientEmail(rec.id);
          if (result && "success" in result && result.success) {
            totalDispatched++;
          } else if (result && "throttled" in result && result.throttled) {
            totalThrottled++;
          }
        }
      }
    } catch (err) {
      logger.error({ err, campaignId: campaign.id }, "Error in campaign dispatch loop");
    }
  }

  return { dispatched: totalDispatched, throttled: totalThrottled, scheduled: totalScheduled };
}
