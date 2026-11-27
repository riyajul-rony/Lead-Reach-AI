import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { decrypt } from "@/server/crypto";
import { queueEmailSend } from "@/server/queues";
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
  subject_template?: string | null;
  body_template?: string | null;
  ai_instruction?: string | null;
  tracking_open?: boolean | null;
  tracking_click?: boolean | null;
}

const CAMPAIGN_STEP_SELECT = {
  id: true,
  campaign_id: true,
  step_no: true,
  delay_days: true,
  mode: true,
  subject_template: true,
  body_template: true,
  ai_instruction: true,
  tracking_open: true,
  tracking_click: true,
} satisfies Prisma.campaign_stepsSelect;

export async function getCampaignSequence(campaignId: string) {
  const [campaign, steps] = await Promise.all([
    db.outreach_campaigns.findFirst({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        status: true,
      } satisfies Prisma.outreach_campaignsSelect,
    }),
    db.campaign_steps.findMany({
      where: { campaign_id: campaignId },
      orderBy: { step_no: "asc" },
      select: CAMPAIGN_STEP_SELECT,
    }),
  ]);

  const normalizedSteps: FollowupStep[] = (steps || []).map((s: any) => ({
    step_no: s.step_no,
    delay_days: s.delay_days,
    mode: s.mode || "custom",
    subject_template: s.subject_template ?? null,
    body_template: s.body_template ?? null,
    ai_instruction: s.ai_instruction ?? null,
    tracking_open: Boolean(s.tracking_open),
    tracking_click: Boolean(s.tracking_click),
  }));

  return {
    campaign_id: campaignId,
    name: campaign?.name ? `${campaign.name} Sequence` : "Campaign Followup Sequence",
    status: normalizedSteps.length > 0 ? "active" : "none",
    steps: normalizedSteps,
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

  const campaign = await db.outreach_campaigns.findFirst({
    where: { id: campaignId, user_id: userId },
    select: { id: true, name: true } satisfies Prisma.outreach_campaignsSelect,
  });

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  // Ensure steps have valid step_no and delay_days
  const sanitizedSteps = steps.map((s, idx) => ({
    step_no: idx + 1,
    delay_days: Math.max(Number(s.delay_days) || 1, 1),
    mode: (s.mode === "ai" ? "ai" : "custom") as "custom" | "ai",
    subject_template: s.subject_template || "Re: {{previous_subject}}",
    body_template: s.body_template || "Hi {{first_name|there}},\n\nJust following up on my previous note.",
    ai_instruction: s.ai_instruction || null,
    tracking_open: Boolean(s.tracking_open),
    tracking_click: Boolean(s.tracking_click),
  }));

  const savedSteps = await db.$transaction(async (tx: any) => {
    for (const step of sanitizedSteps) {
      const createData: Prisma.campaign_stepsUncheckedCreateInput = {
        campaign_id: campaignId,
        step_no: step.step_no,
        delay_days: step.delay_days,
        mode: step.mode,
        subject_template: step.subject_template,
        body_template: step.body_template,
        ai_instruction: step.ai_instruction,
        tracking_open: step.tracking_open,
        tracking_click: step.tracking_click,
      };
      const updateData: Prisma.campaign_stepsUpdateInput = {
        delay_days: step.delay_days,
        mode: step.mode,
        subject_template: step.subject_template,
        body_template: step.body_template,
        ai_instruction: step.ai_instruction,
        tracking_open: step.tracking_open,
        tracking_click: step.tracking_click,
      };
      await tx.campaign_steps.upsert({
        where: {
          campaign_id_step_no: {
            campaign_id: campaignId,
            step_no: step.step_no,
          },
        },
        create: createData,
        update: updateData,
      });
    }

    const existingSteps = await tx.campaign_steps.findMany({
      where: { campaign_id: campaignId },
      orderBy: { step_no: "asc" },
      select: { id: true, step_no: true } satisfies Prisma.campaign_stepsSelect,
    });

    const maxStepNo = sanitizedSteps.length;
    const candidateDeletions = (existingSteps || []).filter(
      (s: { id: string; step_no: number }) => s.step_no > maxStepNo && s.step_no !== 1
    );

    if (candidateDeletions.length > 0) {
      const campaignRecipients = await tx.campaign_recipients.findMany({
        where: { campaign_id: campaignId },
        select: { id: true, current_step: true } satisfies Prisma.campaign_recipientsSelect,
      });
      const allRecipientIds = (campaignRecipients || []).map((r: { id: string }) => r.id);

      for (const candidate of candidateDeletions) {
        const variantsForStep = await tx.campaign_variants.findMany({
          where: { campaign_id: campaignId, step_no: candidate.step_no },
          select: { id: true } satisfies Prisma.campaign_variantsSelect,
        });
        if (variantsForStep.length > 0) {
          continue; // Keep step because variants are attached
        }

        if (allRecipientIds.length > 0) {
          const messageCount = await tx.email_messages.count({
            where: {
              recipient_id: { in: allRecipientIds },
              step_no: candidate.step_no,
            },
          });
          if (messageCount > 0) {
            continue; // Keep step because sent/received messages reference it
          }

          const reachedRecipientIds = (campaignRecipients || [])
            .filter((r: { id: string; current_step: number }) => (r.current_step || 0) >= candidate.step_no)
            .map((r: { id: string }) => r.id);

          if (reachedRecipientIds.length > 0) {
            const trackingCount = await tx.tracking_events.count({
              where: {
                campaign_id: campaignId,
                recipient_id: { in: reachedRecipientIds },
              },
            });
            if (trackingCount > 0) {
              continue; // Keep step because tracking events reference recipients at this step
            }
          }
        }

        await tx.campaign_steps.delete({
          where: { id: candidate.id },
        });
      }
    }

    return tx.campaign_steps.findMany({
      where: { campaign_id: campaignId },
      orderBy: { step_no: "asc" },
      select: CAMPAIGN_STEP_SELECT,
    });
  });

  logger.info({ campaignId, stepsCount: sanitizedSteps.length }, "Saved campaign followup sequence");
  return {
    campaign_id: campaignId,
    name: name || `${campaign.name} Sequence`,
    status: savedSteps.length > 0 ? "active" : "none",
    steps: savedSteps,
  };
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

  // Strict stop-on-reply / suppression check: only "sent" leads without replies can receive follow-ups
  if (recipient.status !== "sent" || recipient.replied_at) {
    return {
      skipped: true,
      reason: recipient.replied_at
        ? "Recipient has already replied"
        : `Recipient status is ${recipient.status} (only 'sent' status receives followups)`,
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

  // Load canonical steps from campaign_steps
  const sequenceSteps: FollowupStep[] = await db.campaign_steps.findMany({
    where: { campaign_id: campaign.id },
    orderBy: { step_no: "asc" },
    select: CAMPAIGN_STEP_SELECT,
  });

  if (!sequenceSteps || sequenceSteps.length === 0) {
    return { skipped: true, reason: "No active followup sequence configured" };
  }

  const currentStep = recipient.current_step || 0;
  const nextStepNo = currentStep + 1;
  const step = sequenceSteps.find((s) => s.step_no === nextStepNo);

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
      const subsequentStep = sequenceSteps.find((s) => s.step_no === step.step_no + 1);
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

    const stepTrackingOpen =
      typeof step.tracking_open === "boolean"
        ? step.tracking_open
        : Boolean(campaign.tracking_open);
    const stepTrackingClick =
      typeof step.tracking_click === "boolean"
        ? step.tracking_click
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

    const nextStep = sequenceSteps.find((s) => s.step_no === step.step_no + 1);
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
 * Periodic dispatch loop: Finds running campaigns with active steps and dispatches due followups.
 */
export async function dispatchDueFollowups(
  now: Date = new Date()
): Promise<{ dispatched: number; throttled: number; skipped: number; scheduled: number }> {
  const runningCampaigns = await db.outreach_campaigns.findMany({
    where: { status: "running" },
  });
  const pausedUsers = await getPausedUserIdsSet();

  let totalDispatched = 0;
  let totalThrottled = 0;
  let totalSkipped = 0;
  let totalScheduled = 0;

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

      // Load canonical campaign steps
      const steps: FollowupStep[] = await db.campaign_steps.findMany({
        where: { campaign_id: campaign.id },
        orderBy: { step_no: "asc" },
        select: CAMPAIGN_STEP_SELECT,
      });

      if (!steps || steps.length === 0) {
        continue;
      }

      const maxStepNo = steps[steps.length - 1].step_no;

      // Stale catch-up protection: Mark overdue follow-ups older than stale threshold as needs_review
      const staleHours = Number(process.env.STALE_THRESHOLD_HOURS) || 24;
      const staleCutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      try {
        const staleRecipients = await db.campaign_recipients.updateMany({
          where: {
            campaign_id: campaign.id,
            status: "sent",
            next_followup_at: { not: null, lt: staleCutoff },
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

      // Select ONLY due recipients with non-null next_followup_at, no reply, and remaining steps (no lower bound on next_followup_at)
      const eligibleRecipients = await db.campaign_recipients.findMany({
        where: {
          campaign_id: campaign.id,
          status: "sent",
          replied_at: null,
          current_step: { lt: maxStepNo },
          next_followup_at: { not: null, lte: now },
        },
        orderBy: { next_followup_at: "asc" },
        take: 20,
      });

      if (eligibleRecipients.length === 0) {
        continue;
      }

      // Batch-fetch suppressions so suppressed recipients are excluded and marked unsubscribed
      const candidateEmails = Array.from(
        new Set(eligibleRecipients.map((r: any) => String(r.email || "").toLowerCase()).filter(Boolean))
      ) as string[];
      const suppressedEmails = new Set<string>();
      if (candidateEmails.length > 0 && db.suppressions?.findMany) {
        const supRows = await db.suppressions.findMany({
          where: { user_id: campaign.user_id, email: { in: candidateEmails } },
          select: { email: true } satisfies Prisma.suppressionsSelect,
        });
        for (const s of supRows) {
          if (s.email) suppressedEmails.add(String(s.email).toLowerCase());
        }
      }

      // Batch-fetch lead & account timezones and jitter settings for recipient evaluation
      const leadIds = Array.from(
        new Set(eligibleRecipients.map((r: any) => r.lead_id).filter(Boolean))
      ) as string[];
      const leadTimezoneMap = new Map<string, string | null>();
      if (leadIds.length > 0 && db.leads?.findMany) {
        try {
          const leadRows = await db.leads.findMany({
            where: { id: { in: leadIds } },
            select: { id: true, timezone: true } satisfies Prisma.leadsSelect,
          });
          for (const l of leadRows) {
            leadTimezoneMap.set(l.id, l.timezone || null);
          }
        } catch {}
      }

      const accountIds = Array.from(
        new Set(eligibleRecipients.map((r: any) => r.assigned_account_id).filter(Boolean))
      ) as string[];
      const accountMap = new Map<string, any>();
      if (accountIds.length > 0 && db.email_accounts?.findMany) {
        try {
          const accRows = await db.email_accounts.findMany({
            where: { id: { in: accountIds } },
            select: {
              id: true,
              timezone: true,
              next_allowed_at: true,
              min_gap_seconds: true,
              max_gap_seconds: true,
              gap_seconds: true,
            } satisfies Prisma.email_accountsSelect,
          });
          for (const a of accRows) {
            accountMap.set(a.id, a);
          }
        } catch {}
      }

      const perAccountNextSlotMs = new Map<string, number>();

      for (const rec of eligibleRecipients) {
        const currentStep = rec.current_step || 0;
        const nextStep = steps.find((s) => s.step_no === currentStep + 1);
        if (!nextStep || currentStep >= maxStepNo) {
          continue;
        }

        if (rec.replied_at) {
          totalSkipped++;
          continue;
        }

        if (suppressedEmails.has(String(rec.email || "").toLowerCase())) {
          await db.campaign_recipients.update({
            where: { id: rec.id },
            data: { status: "unsubscribed", next_followup_at: null, error: "Suppression match" },
          }).catch(() => null);
          totalSkipped++;
          continue;
        }

        const acc = rec.assigned_account_id ? accountMap.get(rec.assigned_account_id) : null;
        const recipientTimezone =
          normalizeIanaTimezone((rec.vars as any)?.timezone) ||
          normalizeIanaTimezone(rec.lead_id ? leadTimezoneMap.get(rec.lead_id) : null);
        const accountTimezone = acc?.timezone ?? null;
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

        const { minSeconds: accountMinGap, maxSeconds: accountMaxGap } =
          resolveAccountJitterBounds(acc, campaign);
        let accountCooldownMs = 0;
        if (acc?.next_allowed_at && new Date(acc.next_allowed_at) > now) {
          accountCooldownMs = new Date(acc.next_allowed_at).getTime() - now.getTime();
        }

        const accountKey = rec.assigned_account_id || "__unassigned__";
        const jitterSec = calculateRandomJitterSec(accountMinGap, accountMaxGap);
        const existingSlotMs = perAccountNextSlotMs.get(accountKey);
        const totalDelayMs =
          existingSlotMs === undefined
            ? accountCooldownMs
            : Math.max(existingSlotMs, accountCooldownMs);
        perAccountNextSlotMs.set(accountKey, totalDelayMs + jitterSec * 1000);

        // Enqueue via normal email-send queue with per-account jitter; fall back inline only if Redis is unavailable
        const enqueued = await queueEmailSend(rec.id, totalDelayMs, nextStep.step_no, "followup");
        if (enqueued) {
          totalScheduled++;
        } else {
          if (accountCooldownMs > 0) {
            totalThrottled++;
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
      }
    } catch (err) {
      logger.error({ err, campaignId: campaign.id }, "Error in followup dispatch loop");
    }
  }

  return {
    dispatched: totalDispatched,
    throttled: totalThrottled,
    skipped: totalSkipped,
    scheduled: totalScheduled,
  };
}
