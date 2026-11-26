import crypto from "node:crypto";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { decrypt } from "@/server/crypto";
import { accountHasWorkingReplyDetection, getEffectiveAccountDailyLimit } from "@/server/email/account-service";
import { renderEmailTemplate, resolveSpintax } from "@/server/email/template-renderer";
import { getUserApiKey } from "@/server/api-keys/service";
import { generateOutreachEmail } from "@/server/ai/outreach-generator";
import { assertLimit } from "@/server/billing/limits";
import { trackUsageIncrement } from "@/server/billing/usage-tracker";
import { buildEmailMultipartBodies, calculateRandomJitterSec, dispatchEmailTransport } from "@/server/email/sending-engine";
import { selectVariantForRecipient } from "@/server/email/variant-service";
import { resolveTrackingBaseUrl } from "@/server/email/tracking-domain-service";
import { resolveUserWorkspaceBusinessAddress } from "@/server/workspace/settings";
import {
  getPausedUserIdsSet,
  isUserWorkspaceSendingPaused,
} from "@/server/workspace/sending-control";
import { resolveSenderFirstName } from "@/server/email/sender-identity";
import { resolveAccountJitterBounds } from "@/server/email/send-jitter";
import {
  isPermanentHardBounceSmtpError,
  isSmtpAuthFailureError,
  recordAccountAuthFailure,
  recordHardBounceAndSuppress,
  resetAccountAuthFailures,
} from "@/server/email/deliverability-pause";
import {
  commitAccountDailyCapacity,
  ensureAccountRampStarted,
  isGmailDailyLimitError,
  markAccountRateLimitedForToday,
  releaseAccountDailyCapacity,
  reserveAccountDailyCapacity,
  type DailyCapacityReservation,
} from "@/server/email/daily-capacity";
import {
  isWithinSendingWindow,
  normalizeIanaTimezone,
  resolveEffectiveSendingTimezone,
} from "@/server/email/timezone";

const BASE_URL = process.env.NEXTAUTH_URL || process.env.APP_URL || "http://localhost:3000";

export interface FollowupStep {
  step_no: number;
  delay_days: number;
  mode: "custom" | "ai";
  subject_template?: string;
  body_template?: string;
  ai_instruction?: string;
  tracking_open?: boolean;
  tracking_click?: boolean;
}

export async function getCampaignSequence(campaignId: string) {
  const existing = await db.followup_sequences.findFirst({
    where: { campaign_id: campaignId },
  });

  if (existing) {
    return existing;
  }

  // Return default 2-step followup blueprint
  return {
    campaign_id: campaignId,
    status: "active",
    steps: [
      {
        step_no: 1,
        delay_days: 3,
        mode: "custom",
        subject_template: "Re: {{previous_subject}}",
        body_template:
          "Hi {{first_name|there}},\n\nJust floating this to the top of your inbox in case you missed my earlier email regarding {{company_name|your business}}.\n\nDo you have 5 minutes for a quick chat this week?\n\nBest regards,\nAlex",
        tracking_open: false,
        tracking_click: false,
      },
      {
        step_no: 2,
        delay_days: 5,
        mode: "custom",
        subject_template: "Re: {{previous_subject}}",
        body_template:
          "Hi {{first_name|there}},\n\nI understand you might be busy, so this will be my final follow-up. If this isn't relevant for {{company_name|your team}} right now, no worries at all!\n\nWishing you all the best,\nAlex",
        tracking_open: false,
        tracking_click: false,
      },
    ],
  };
}

export async function saveCampaignSequence(
  userId: string,
  campaignId: string,
  name: string,
  steps: FollowupStep[]
) {
  if (steps.length > 5) {
    throw new Error("Maximum of 5 followup steps allowed per sequence");
  }

  // Ensure steps have valid step_no and delay_days
  const sanitizedSteps = steps.map((s, idx) => ({
    step_no: idx + 1,
    delay_days: Math.max(Number(s.delay_days) || 1, 1),
    mode: s.mode || "custom",
    subject_template: s.subject_template || "Re: {{previous_subject}}",
    body_template: s.body_template || "Hi {{first_name|there}},\n\nJust following up on my previous note.",
    ai_instruction: s.ai_instruction || null,
    tracking_open: Boolean(s.tracking_open),
    tracking_click: Boolean(s.tracking_click),
  }));

  const saved = await db.followup_sequences.create({
    data: {
      user_id: userId,
      campaign_id: campaignId,
      name: name || `Sequence for Campaign ${campaignId.slice(0, 8)}`,
      status: "active",
      steps: sanitizedSteps as any,
    },
  });

  logger.info({ campaignId, stepsCount: sanitizedSteps.length }, "Saved campaign followup sequence");
  return saved;
}

/**
 * Dispatches a single scheduled follow-up step for an eligible recipient.
 * Adheres strictly to stop-on-reply, 25/hr rate cap, suppression check, and thread headers.
 */
export async function sendSingleRecipientFollowup(
  recipientId: string,
  now: Date = new Date()
) {
  const recipient = await db.campaign_recipients.findFirst({
    where: { id: recipientId },
  });

  if (!recipient) {
    return { skipped: true, reason: "Recipient not found" };
  }

  // Strict stop-on-reply / suppression check: only "sent" leads can receive follow-ups
  if (recipient.status !== "sent") {
    return {
      skipped: true,
      reason: `Recipient status is ${recipient.status} (only 'sent' status receives followups)`,
    };
  }

  const campaign = await db.outreach_campaigns.findFirst({
    where: { id: recipient.campaign_id },
  });

  if (!campaign || campaign.status !== "running") {
    return { skipped: true, reason: "Campaign is not running" };
  }

  const wsPause = await isUserWorkspaceSendingPaused(recipient.user_id);
  if (wsPause.paused) {
    return {
      throttled: true,
      workspacePaused: true,
      reason: wsPause.reason || "Workspace sending is paused by an administrator",
    };
  }

  // Find active sequence
  const sequence = await db.followup_sequences.findFirst({
    where: { campaign_id: campaign.id, status: "active" },
  });

  if (!sequence || !Array.isArray(sequence.steps) || sequence.steps.length === 0) {
    return { skipped: true, reason: "No active followup sequence configured" };
  }

  const currentStep = recipient.current_step || 0;
  const nextStepNo = currentStep + 1;
  const step = sequence.steps.find((s: FollowupStep) => s.step_no === nextStepNo);

  if (!step) {
    return { skipped: true, reason: "All sequence steps completed for recipient" };
  }

  // Idempotency guard: ensure this exact follow-up step was not already sent (prevents duplicate step on partial failures/retries)
  try {
    const alreadySentStep = await db.email_messages.findFirst({
      where: {
        recipient_id: recipient.id,
        direction: "out",
        kind: "followup",
        step_no: step.step_no,
        status: "sent",
      },
    });
    if (alreadySentStep) {
      const subsequentStep = sequence.steps.find((s: FollowupStep) => s.step_no === step.step_no + 1);
      const nextAt = subsequentStep
        ? new Date(now.getTime() + (Number(subsequentStep.delay_days) || 1) * 86400000)
        : null;
      await db.campaign_recipients.update({
        where: { id: recipient.id },
        data: {
          current_step: step.step_no,
          next_followup_at: nextAt,
        },
      });
      return { skipped: true, reason: `Follow-up step ${step.step_no} already sent` };
    }
  } catch {}

  // Delay verification
  const delayDays = Math.max(Number(step.delay_days) || 1, 1);
  const delayMs = delayDays * 24 * 60 * 60 * 1000;
  const referenceDate = recipient.last_sent_at || recipient.sent_at || recipient.created_at;

  if (referenceDate) {
    const dueTime = new Date(new Date(referenceDate).getTime() + delayMs);
    if (now.getTime() < dueTime.getTime()) {
      return {
        skipped: true,
        reason: `Followup step ${nextStepNo} due at ${dueTime.toISOString()}`,
      };
    }
  }

  // 1. Check suppression list
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

  // 2. Fetch assigned sender account & check 25/hr rate cap
  if (!recipient.assigned_account_id) {
    return { skipped: true, reason: "No assigned sender email account" };
  }

  const account = await db.email_accounts.findFirst({
    where: { id: recipient.assigned_account_id },
  });

  if (!account || account.status !== "active") {
    if (account?.status === "paused_deliverability") {
      return {
        throttled: true,
        pausedDeliverability: true,
        reason:
          account.deliverability_pause_reason ||
          "Sender account is paused due to deliverability signals",
      };
    }
    return { skipped: true, reason: "Assigned sender account is not active" };
  }

  // Pre-dispatch Reply Detection Guard: Do not send follow-ups if account cannot detect replies
  const replyCheck = accountHasWorkingReplyDetection(account);
  if (!replyCheck.capable) {
    logger.warn(
      { recipientId: recipient.id, accountId: account.id, email: account.from_email },
      "Skipping follow-up dispatch: account does not have working reply detection"
    );
    return {
      skipped: true,
      reason: "Sender account does not support reply detection. Follow-ups disabled.",
    };
  }

  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const sentLastHour = await db.email_messages.count({
    where: {
      email_account_id: account.id,
      sent_at: { gte: sixtyMinutesAgo },
      status: "sent",
    },
  });

  const hourlyCap = Math.min(account.hourly_limit || 25, 25);
  if (sentLastHour >= hourlyCap) {
    logger.warn(
      { accountId: account.id, sentLastHour, hourlyCap },
      "Account reached hourly limit, postponing followup"
    );
    return { throttled: true, reason: "Hourly limit reached" };
  }

  // Per-account wait gap cooldown
  if (account.next_allowed_at && new Date(account.next_allowed_at) > now) {
    const cooldownMs = new Date(account.next_allowed_at).getTime() - now.getTime();
    const cooldownSec = Math.ceil(cooldownMs / 1000);
    logger.warn({ accountId: account.id, cooldownSec }, "Account wait gap cooldown active, postponing followup");
    return { throttled: true, reason: `Account wait gap active (cooldown: ${cooldownSec}s remaining)` };
  }

  // Plan limits (monthly and daily outreach quotas)
  try {
    await assertLimit(recipient.user_id, "monthly_outreach_emails", 1);
    await assertLimit(recipient.user_id, "daily_outreach_emails", 1);
  } catch (err: any) {
    logger.warn({ recipientId: recipient.id, userId: recipient.user_id, err: err.message }, "Outreach quota exceeded for followup");
    return { skipped: true, throttled: true, reason: err.message };
  }

  // Atomic UTC daily capacity reservation (adaptive cap + 50% safety invariant)
  const capReservation = await reserveAccountDailyCapacity(account, now);
  if (!capReservation.allowed) {
    logger.warn(
      {
        accountId: account.id,
        sentToday: capReservation.snapshot.campaignSentToday,
        dailyCap: capReservation.snapshot.effectiveCampaignDailyCap,
      },
      "Account reached daily warmup limit, postponing followup"
    );
    return { throttled: true, reason: capReservation.reason };
  }
  const reservedSlot: DailyCapacityReservation = capReservation.reservation;

  // 3. Render Subject and Body
  const trackingBaseUrl = await resolveTrackingBaseUrl(
    recipient.user_id,
    campaign.tracking_domain_id
  );
  const unsubscribeUrl = `${trackingBaseUrl}/u/${recipient.unsubscribe_token}`;
  const businessAddress = await resolveUserWorkspaceBusinessAddress(recipient.user_id);
  const templateVars = {
    ...(recipient.vars || {}),
    business_address: businessAddress,
    sender_first_name: resolveSenderFirstName(account),
  };

  let finalSubject = "";
  let finalBody = "";
  let selectedVariantId: string | null = null;

  try {
    const selectedVariant = await selectVariantForRecipient(campaign.id, step.step_no, recipient);
    if (selectedVariant) {
      selectedVariantId = selectedVariant.id;
    }
    const effectiveStepSubject = selectedVariant?.subject_template || step.subject_template;
    const effectiveStepBody = selectedVariant?.body_template || step.body_template;

    if (step.mode === "ai") {
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
        try {
          const generated = await generateOutreachEmail({
            apiKey: rawApiKey,
            senderName: account.from_name || account.from_email,
            recipientName: recipient.name || undefined,
            recipientCompany: recipient.company || undefined,
            recipientWebsite: recipient.vars?.website || undefined,
            goalOrOffer: step.ai_instruction || campaign.ai_config?.goalOrOffer,
            tone: campaign.ai_config?.tone || "conversational",
            textModel: campaign.text_model || campaign.ai_config?.textModel,
          });
          const rawSubj = resolveSpintax(generated.subject || "Quick follow-up");
          finalSubject = rawSubj.startsWith("Re:") ? rawSubj : `Re: ${rawSubj}`;
          finalBody = resolveSpintax(generated.body);
        } catch {
          // Fallback if AI generation encounters issue
          finalSubject = renderEmailTemplate(
            effectiveStepSubject || "Re: {{previous_subject}}",
            { ...templateVars, previous_subject: recipient.generated_subject || "our conversation" },
            unsubscribeUrl
          );
          finalBody = renderEmailTemplate(
            effectiveStepBody || "Hi {{first_name|there}},\n\nJust floating this to the top of your inbox.",
            templateVars,
            unsubscribeUrl
          );
        }
      } else {
        finalSubject = renderEmailTemplate(
          effectiveStepSubject || "Re: {{previous_subject}}",
          { ...templateVars, previous_subject: recipient.generated_subject || "our conversation" },
          unsubscribeUrl
        );
        finalBody = renderEmailTemplate(
          effectiveStepBody || "Hi {{first_name|there}},\n\nJust floating this to the top of your inbox.",
          templateVars,
          unsubscribeUrl
        );
      }
    } else {
      // Custom Template Mode
      finalSubject = renderEmailTemplate(
        effectiveStepSubject || "Re: {{previous_subject}}",
        { ...templateVars, previous_subject: recipient.generated_subject || "our conversation" },
        unsubscribeUrl
      );
      finalBody = renderEmailTemplate(
        effectiveStepBody || "Hi {{first_name|there}},\n\nJust floating this to the top of your inbox.",
        templateVars,
        unsubscribeUrl
      );
    }

    let stepRecord: any = null;
    try {
      if (db.campaign_steps?.findFirst) {
        stepRecord = await db.campaign_steps.findFirst({
          where: { campaign_id: campaign.id, step_no: step.step_no },
          select: { tracking_open: true, tracking_click: true },
        });
      }
    } catch {}

    const stepTrackingOpen =
      typeof step.tracking_open === "boolean"
        ? step.tracking_open
        : typeof stepRecord?.tracking_open === "boolean"
          ? stepRecord.tracking_open
          : Boolean(campaign.tracking_open);
    const stepTrackingClick =
      typeof step.tracking_click === "boolean"
        ? step.tracking_click
        : typeof stepRecord?.tracking_click === "boolean"
          ? stepRecord.tracking_click
          : Boolean(campaign.tracking_click);

    // 4. Construct Pure Message body (text/plain only unless tracking/HTML is active)
    const { text: plainTextBody, html: htmlBody } = buildEmailMultipartBodies({
      bodyText: finalBody,
      unsubscribeUrl,
      trackingOpen: stepTrackingOpen,
      trackingClick: stepTrackingClick,
      unsubscribeToken: recipient.unsubscribe_token,
      baseUrl: trackingBaseUrl,
    });

    const senderDomain = account.from_email.split("@")[1] || "leadreach.ai";
    const explicitMessageId = `<${crypto.randomUUID()}@${senderDomain}>`;
    const threadHeader = recipient.thread_message_id || undefined;

    const transportResult = await dispatchEmailTransport({
      account,
      to: recipient.email,
      subject: finalSubject,
      text: plainTextBody,
      html: htmlBody,
      explicitMessageId,
      inReplyTo: threadHeader,
      references: threadHeader,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-LeadReachAI-Campaign-Id": campaign.id,
        "X-LeadReachAI-Recipient-Id": recipient.id,
        "X-LeadReachAI-Step-No": String(step.step_no),
      },
    });

    const messageId = transportResult.messageId;

    // 5. Record message and update recipient step
    await db.email_messages.create({
      data: {
        user_id: recipient.user_id,
        recipient_id: recipient.id,
        email_account_id: account.id,
        variant_id: selectedVariantId,
        direction: "out",
        kind: "followup",
        step_no: step.step_no,
        message_id: messageId,
        in_reply_to: threadHeader || null,
        subject: finalSubject,
        snippet: finalBody.slice(0, 150),
        status: "sent",
        sent_at: now,
      },
    });

    commitAccountDailyCapacity(reservedSlot);
    await ensureAccountRampStarted(account, now);

    const nextStep = sequence.steps.find((s: FollowupStep) => s.step_no === step.step_no + 1);
    const nextFollowupAt = nextStep
      ? new Date(now.getTime() + (Number(nextStep.delay_days) || 1) * 86400000)
      : null;

    await db.campaign_recipients.update({
      where: { id: recipient.id },
      data: {
        current_step: step.step_no,
        last_sent_at: now,
        next_followup_at: nextFollowupAt,
      },
    });

    // Update account's next_allowed_at wait gap cooldown (default 120–300s)
    const { minSeconds: minGap, maxSeconds: maxGap } = resolveAccountJitterBounds(account, campaign);
    const gapSec = calculateRandomJitterSec(minGap, maxGap);
    const nextAllowed = new Date(now.getTime() + gapSec * 1000);
    try {
      await db.email_accounts.update({
        where: { id: account.id },
        data: { next_allowed_at: nextAllowed },
      });
      if (account.consecutive_smtp_auth_failures > 0) {
        await resetAccountAuthFailures(account.id);
      }
    } catch {}

    trackUsageIncrement(recipient.user_id, "monthly_outreach_emails", 1).catch(() => null);

    logger.info(
      {
        recipientId: recipient.id,
        email: recipient.email,
        stepNo: step.step_no,
        messageId,
      },
      "Follow-up email dispatched successfully"
    );

    return { success: true, messageId, stepNo: step.step_no };
  } catch (err: unknown) {
    await releaseAccountDailyCapacity(reservedSlot);
    const errorMsg = err instanceof Error ? err.message : "Failed to send followup email";
    if (isGmailDailyLimitError(errorMsg)) {
      const retryAt = await markAccountRateLimitedForToday(account.id, errorMsg, now);
      await db.campaign_recipients.update({
        where: { id: recipient.id },
        data: { next_followup_at: retryAt },
      }).catch(() => null);
      return { throttled: true, rateLimited: true, reason: errorMsg };
    }
    if (isSmtpAuthFailureError(errorMsg)) {
      const authRes = await recordAccountAuthFailure(account.id, errorMsg, now);
      return {
        throttled: true,
        authFailed: true,
        accountPaused: authRes.paused,
        reason: errorMsg,
      };
    }
    if (isPermanentHardBounceSmtpError(errorMsg)) {
      const bounceEval = await recordHardBounceAndSuppress({
        userId: recipient.user_id,
        accountId: account.id,
        recipientId: recipient.id,
        campaignId: campaign.id,
        email: recipient.email,
        reason: errorMsg,
        now,
      });
      return {
        success: false,
        bounced: true,
        accountPaused: bounceEval.paused,
        error: errorMsg,
      };
    }
    logger.error(
      { err, recipientId: recipient.id, stepNo: step.step_no },
      "Failed to dispatch followup email"
    );
    return { success: false, error: errorMsg };
  }
}

/**
 * Periodic dispatch loop: Finds running campaigns with active sequences and dispatches due followups.
 */
export async function dispatchDueFollowups(
  now: Date = new Date()
): Promise<{ dispatched: number; throttled: number; skipped: number }> {
  const runningCampaigns = await db.outreach_campaigns.findMany({
    where: { status: "running" },
  });
  const pausedUsers = await getPausedUserIdsSet();

  let totalDispatched = 0;
  let totalThrottled = 0;
  let totalSkipped = 0;

  for (const campaign of runningCampaigns) {
    try {
      if (pausedUsers.has(campaign.user_id)) {
        continue; // Admin-paused workspace: hold due followups cleanly without stale expiry
      }
      const startHour = campaign.send_window?.startHour ?? 0;
      const endHour = campaign.send_window?.endHour ?? 24;
      const daysOfWeek =
        Array.isArray(campaign.days_of_week) && campaign.days_of_week.length > 0
          ? campaign.days_of_week
          : [1, 2, 3, 4, 5, 6, 7];

      // Check active sequence
      const sequence = await db.followup_sequences.findFirst({
        where: { campaign_id: campaign.id, status: "active" },
      });

      if (!sequence || !Array.isArray(sequence.steps) || sequence.steps.length === 0) {
        continue;
      }

      // Stale catch-up protection: Mark overdue follow-ups older than stale threshold as needs_review
      const staleHours = Number(process.env.STALE_THRESHOLD_HOURS) || 24;
      const staleCutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      try {
        const staleRecipients = await db.campaign_recipients.updateMany({
          where: {
            campaign_id: campaign.id,
            status: "sent",
            next_followup_at: { lt: staleCutoff },
          },
          data: {
            status: "needs_review",
            error: `Follow-up due date is older than stale threshold (${staleHours}h). Requires review.`,
          },
        });
        if (staleRecipients.count > 0) {
          logger.warn(
            { campaignId: campaign.id, count: staleRecipients.count },
            "Catch-up protection: Marked overdue follow-ups as needs_review"
          );
        }
      } catch (err) {
        logger.error({ err, campaignId: campaign.id }, "Failed to apply catch-up protection to followups");
      }

      const eligibleRecipients = await db.campaign_recipients.findMany({
        where: {
          campaign_id: campaign.id,
          status: "sent",
          OR: [
            { next_followup_at: null },
            { next_followup_at: { gte: staleCutoff, lte: now } },
          ],
        },
        take: 20,
      });

      // Batch-fetch lead & account timezones for recipient sending-window evaluation
      const leadIds = Array.from(
        new Set(eligibleRecipients.map((r: any) => r.lead_id).filter(Boolean))
      ) as string[];
      const leadTimezoneMap = new Map<string, string | null>();
      if (leadIds.length > 0 && db.leads?.findMany) {
        try {
          const leadRows = await db.leads.findMany({
            where: { id: { in: leadIds } },
            select: { id: true, timezone: true },
          });
          for (const l of leadRows) {
            leadTimezoneMap.set(l.id, l.timezone || null);
          }
        } catch {}
      }

      const accountIds = Array.from(
        new Set(eligibleRecipients.map((r: any) => r.assigned_account_id).filter(Boolean))
      ) as string[];
      const accountTimezoneMap = new Map<string, string | null>();
      if (accountIds.length > 0 && db.email_accounts?.findMany) {
        try {
          const accRows = await db.email_accounts.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, timezone: true },
          });
          for (const a of accRows) {
            accountTimezoneMap.set(a.id, a.timezone || null);
          }
        } catch {}
      }

      for (const rec of eligibleRecipients) {
        const currentStep = rec.current_step || 0;
        if (currentStep >= sequence.steps.length) {
          continue;
        }

        const recipientTimezone =
          normalizeIanaTimezone((rec.vars as any)?.timezone) ||
          normalizeIanaTimezone(rec.lead_id ? leadTimezoneMap.get(rec.lead_id) : null);
        const accountTimezone = rec.assigned_account_id
          ? accountTimezoneMap.get(rec.assigned_account_id)
          : null;
        const effectiveTz = resolveEffectiveSendingTimezone({
          recipientTimezone,
          campaignTimezone: campaign.timezone,
          accountTimezone,
        });

        const inWindow = isWithinSendingWindow(now, {
          timezone: effectiveTz,
          startHour,
          endHour,
          daysOfWeek,
        });
        if (!inWindow) {
          totalSkipped++;
          continue;
        }

        const res = await sendSingleRecipientFollowup(rec.id, now);
        if (res && "success" in res && res.success) {
          totalDispatched++;
        } else if (res && "throttled" in res && res.throttled) {
          totalThrottled++;
        } else {
          totalSkipped++;
        }
      }
    } catch (err) {
      logger.error({ err, campaignId: campaign.id }, "Error in followup dispatch loop");
    }
  }

  return { dispatched: totalDispatched, throttled: totalThrottled, skipped: totalSkipped };
}
