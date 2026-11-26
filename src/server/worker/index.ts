import { Worker } from "bullmq";
import { getRedisConnection, QUEUE_NAMES, queueSocialPublish } from "@/server/queues";
import { db } from "@/server/db";
import { computePlannerRuns, isMissed } from "@/server/services/social/schedule";
import { decrypt } from "@/server/crypto";
import { getUserApiKey } from "@/server/api-keys/service";
import { generateSocialPost } from "@/server/ai/social-generator";
import { getSocialProvider } from "@/server/providers/social/registry";
import { logger } from "@/server/logger";
import { dispatchRunningCampaigns, sendSingleRecipientEmail } from "@/server/email/sending-engine";
import { dispatchDueFollowups } from "@/server/email/sequence-service";
import { pollInboxesForReplies } from "@/server/worker/reply-poller";
import { trackUsageIncrement, resetOrArchiveOldUsageCounters } from "@/server/billing/usage-tracker";
import { processSubscriptionLifecycles } from "@/server/billing/lifecycle";
import { recordErrorLog } from "@/server/logging/error-logger";
import { cleanupOldLogs } from "@/server/logging/cleaner";
import { incrementWarmupDayForActiveAccounts } from "@/server/email/account-service";
import { evaluateDailyAccountHealth } from "@/server/email/adaptive-limit-service";
import { runSelfWarmupTick } from "@/server/email/warmup-pool-service";

/**
 * 1. PLANNER WORKER: runs every minute, computes scheduled runs from DB campaigns
 */
export function startPlannerWorker() {
  return new Worker(
    QUEUE_NAMES.PLANNER,
    async () => {
      const startedAt = Date.now();
      const now = new Date();
      logger.info({ at: now.toISOString() }, "Planner tick starting");

      const activeCampaigns = await db.social_campaigns.findMany({
        where: { status: "active" },
        include: { social_account: true, openai_key: true },
      });

      for (const campaign of activeCampaigns) {
        try {
          const { due } = computePlannerRuns(
            {
              postTimes: campaign.post_times,
              daysOfWeek: campaign.days_of_week,
              timezone: campaign.timezone,
              startDate: campaign.start_date ? campaign.start_date.toISOString().slice(0, 10) : null,
              endDate: campaign.end_date ? campaign.end_date.toISOString().slice(0, 10) : null,
            },
            now
          );

          const upsertOps = due.map((scheduledFor) => {
            const missed = isMissed(scheduledFor, now);
            return db.post_runs.upsert({
              where: {
                campaign_id_scheduled_for: {
                  campaign_id: campaign.id,
                  scheduled_for: scheduledFor,
                },
              },
              create: {
                user_id: campaign.user_id,
                campaign_id: campaign.id,
                scheduled_for: scheduledFor,
                status: missed ? "skipped" : "scheduled",
                error_message: missed ? "Missed run grace period exceeded" : null,
              },
              update: {},
            });
          });

          if (upsertOps.length > 0) {
            await db.$transaction(upsertOps);
          }
        } catch (err) {
          logger.error({ err, campaignId: campaign.id }, "Failed to plan campaign runs");
        }
      }

      // Stale catch-up protection: Mark overdue post runs older than stale cutoff as needs_review
      const staleHours = Number(process.env.STALE_THRESHOLD_HOURS) || 24;
      const staleCutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      try {
        const staleRuns = await db.post_runs.updateMany({
          where: {
            status: "scheduled",
            scheduled_for: { lt: staleCutoff },
          },
          data: {
            status: "needs_review",
            error_message: `Post run scheduled_for is older than stale threshold (${staleHours}h). Marked as needs_review for safety.`,
          },
        });
        if (staleRuns.count > 0) {
          logger.warn(
            { count: staleRuns.count, staleCutoff: staleCutoff.toISOString() },
            "Catch-up protection: Marked overdue post runs as needs_review"
          );
        }
      } catch (err) {
        logger.error({ err }, "Failed to apply catch-up protection to overdue post runs");
      }

      // Enqueue any runs that are currently due within the safe window (max 10 to prevent burst)
      try {
        const dueRuns = await db.post_runs.findMany({
          where: {
            status: "scheduled",
            scheduled_for: { gte: staleCutoff, lte: now },
          },
          take: 10,
        });

        for (const run of dueRuns) {
          await queueSocialPublish(run.id);
        }
      } catch (err) {
        logger.error({ err }, "Failed to dispatch due post runs to BullMQ queue");
      }

      // Record last run in Redis
      try {
        const redis = getRedisConnection();
        await redis.set(
          "leadreach:worker:last_run:planner",
          JSON.stringify({
            jobType: "planner",
            timestamp: now.toISOString(),
            durationMs: Date.now() - startedAt,
          }),
          "EX",
          86400
        );
      } catch {}
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}

/**
 * 2. SOCIAL PUBLISH WORKER: executes scheduled post runs
 */
export function startSocialPublishWorker() {
  return new Worker(
    QUEUE_NAMES.SOCIAL_PUBLISH,
    async (job) => {
      const { postRunId } = job.data as { postRunId: string };
      logger.info({ postRunId }, "Processing social publish job");

      const postRun = await db.post_runs.findUnique({
        where: { id: postRunId },
        include: {
          campaign: {
            include: { social_account: true, openai_key: true },
          },
        },
      });

      if (!postRun || postRun.status === "published" || postRun.status === "rejected") {
        return;
      }

      const campaign = postRun.campaign;
      const account = campaign.social_account;

      // Multi-tenant security check: ensure account belongs to campaign owner
      if (account.user_id !== campaign.user_id || postRun.user_id !== campaign.user_id) {
        const err = new Error("Tenant isolation violation: account or post run does not match campaign user");
        logger.error({ postRunId, userId: postRun.user_id }, err.message);
        await db.post_runs.update({
          where: { id: postRun.id },
          data: { status: "failed", error_message: err.message },
        });
        throw err;
      }

      // Transition to generating
      await db.post_runs.update({
        where: { id: postRun.id },
        data: { status: "generating", started_at: new Date() },
      });

      try {
        let fullCaption = postRun.caption || "";
        let hashtags = postRun.hashtags || [];
        let imagePrompt = postRun.image_prompt || "";
        let imageUrl = postRun.external_url || undefined;

        // 1. Generate post content if not already generated
        if (!fullCaption) {
          let rawApiKey = "";
          if (campaign.openai_key) {
            rawApiKey = decrypt(campaign.openai_key.key_enc);
          } else {
            const userKey = await getUserApiKey(campaign.user_id, "openai");
            if (userKey) rawApiKey = userKey;
          }

          if (!rawApiKey) {
            throw new Error("No OpenAI API key found for this user. Please configure your OpenAI API Key in Settings -> API Keys.");
          }

          // Fetch recent post captions to avoid repetition
          const recentRuns = await db.post_runs.findMany({
            where: { campaign_id: campaign.id, status: "published" },
            orderBy: { scheduled_for: "desc" },
            take: 15,
            select: { caption: true },
          });

          const generated = await generateSocialPost({
            apiKey: rawApiKey,
            businessName: campaign.business_name,
            businessCategory: campaign.business_category,
            businessDescription: campaign.business_description,
            targetAudience: campaign.target_audience,
            brandVoice: campaign.brand_voice,
            language: campaign.language,
            prompt: campaign.prompt,
            imageStyle: campaign.image_style,
            captionLength: campaign.caption_length as any,
            includeEmojis: campaign.emojis,
            hashtagsCount: campaign.hashtags_count,
            ctaText: campaign.cta_text,
            recentCaptions: (recentRuns || []).map((r: any) => r.caption || "").filter(Boolean),
            textModel: campaign.text_model,
            imageModel: campaign.image_model,
          });

          fullCaption = `${generated.caption}\n\n${generated.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}`.trim();
          hashtags = generated.hashtags;
          imagePrompt = generated.imagePrompt;
          if (generated.imageUrl) imageUrl = generated.imageUrl;
        }

        // 2. Check approval mode
        if (campaign.approval_mode === "approve" && postRun.status !== "publishing") {
          await db.post_runs.update({
            where: { id: postRun.id },
            data: {
              status: "pending_approval",
              caption: fullCaption,
              hashtags,
              image_prompt: imagePrompt,
              external_url: imageUrl,
            },
          });
          logger.info({ postRunId }, "Post generated and queued for user approval");
          return;
        }

        // 3. Auto mode or approved: publish immediately
        await db.post_runs.update({
          where: { id: postRun.id },
          data: { status: "publishing" },
        });

        const provider = getSocialProvider(account.provider);
        const accountToken = account.access_token_enc ? decrypt(account.access_token_enc) : "";

        const result = await provider.publish(accountToken, account.external_id, {
          caption: fullCaption,
          imageUrl,
        });

        await db.post_runs.update({
          where: { id: postRun.id },
          data: {
            status: "published",
            caption: fullCaption,
            hashtags,
            image_prompt: imagePrompt,
            external_post_id: result.externalId,
            external_url: result.url || imageUrl,
            finished_at: new Date(),
          },
        });

        trackUsageIncrement(postRun.user_id, "monthly_social_posts", 1).catch(() => null);

        logger.info({ postRunId, externalId: result.externalId }, "Post successfully published");
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Unknown publish error";
        logger.error({ err, postRunId }, "Post run failed");

        recordErrorLog({
          source: "worker:social_publish",
          message: errorMsg,
          stack: err instanceof Error ? err.stack : undefined,
          context: { postRunId },
          userId: postRun.user_id,
        }).catch(() => null);

        await db.post_runs.update({
          where: { id: postRun.id },
          data: {
            status: "failed",
            error_message: errorMsg,
            attempts: { increment: 1 },
          },
        });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );
}

/**
 * 3. EMAIL DISPATCH WORKER: checks running campaigns, rate limits, and triggers sends
 */
export function startEmailDispatchWorker() {
  return new Worker(
    QUEUE_NAMES.EMAIL_DISPATCH,
    async () => {
      const startedAt = Date.now();
      logger.info("Email dispatch worker tick starting");
      const result = await dispatchRunningCampaigns();
      const followupResult = await dispatchDueFollowups();
      const durationMs = Date.now() - startedAt;
      logger.info(
        { initialDispatches: result, followupDispatches: followupResult, durationMs },
        "Email dispatch tick completed"
      );

      try {
        const redis = getRedisConnection();
        await redis.set(
          "leadreach:worker:last_run:email-dispatch",
          JSON.stringify({
            jobType: "email-dispatch",
            timestamp: new Date().toISOString(),
            durationMs,
            initialDispatches: result,
            followupDispatches: followupResult,
          }),
          "EX",
          86400
        );
      } catch {}
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}

/**
 * 4. EMAIL SEND WORKER: sends a single recipient email with 25/hr cap & jitter
 */
export function startEmailSendWorker() {
  return new Worker(
    QUEUE_NAMES.EMAIL_SEND,
    async (job) => {
      const { recipientId } = job.data as { recipientId: string };
      logger.info({ recipientId }, "Processing email send job");
      try {
        return await sendSingleRecipientEmail(recipientId);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Email send failed";
        recordErrorLog({
          source: "worker:email_send",
          message: errorMsg,
          stack: err instanceof Error ? err.stack : undefined,
          context: { recipientId, jobId: job.id },
        }).catch(() => null);
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}

/**
 * 5. REPLY POLL WORKER: checks IMAP inboxes for replies and bounces, triggers stop-on-reply
 */
export function startReplyPollWorker() {
  return new Worker(
    QUEUE_NAMES.REPLY_POLL,
    async () => {
      const startedAt = Date.now();
      logger.info("IMAP reply poll worker tick starting");
      const result = await pollInboxesForReplies();
      const durationMs = Date.now() - startedAt;
      logger.info({ ...result, durationMs }, "IMAP reply poll tick completed");

      try {
        const redis = getRedisConnection();
        await redis.set(
          "leadreach:worker:last_run:reply-poll",
          JSON.stringify({
            jobType: "reply-poll",
            timestamp: new Date().toISOString(),
            durationMs,
            result,
          }),
          "EX",
          86400
        );
      } catch {}
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}

/**
 * 6. MAINTENANCE WORKER: periodic cleanup of archived usage counters & expired data
 */
export function startMaintenanceWorker() {
  return new Worker(
    QUEUE_NAMES.MAINTENANCE,
    async () => {
      const startedAt = Date.now();
      logger.info("Maintenance worker tick starting");
      const result = await resetOrArchiveOldUsageCounters();
      const lifecycleResult = await processSubscriptionLifecycles();
      const purgeResult = await cleanupOldLogs(90);
      const warmupResult = await incrementWarmupDayForActiveAccounts();
      const healthResult = await evaluateDailyAccountHealth();
      const durationMs = Date.now() - startedAt;
      logger.info(
        {
          archivedCounters: result,
          lifecycles: lifecycleResult,
          purgedLogs: purgeResult,
          warmupIncrements: warmupResult,
          accountHealthEval: healthResult,
          durationMs,
        },
        "Maintenance tick completed (archived counters, processed lifecycles, purged 90d logs, warmup incremented & account health evaluated)"
      );

      try {
        const redis = getRedisConnection();
        await redis.set(
          "leadreach:worker:last_run:maintenance",
          JSON.stringify({
            jobType: "maintenance",
            timestamp: new Date().toISOString(),
            durationMs,
            archivedCounters: result,
            lifecycles: lifecycleResult,
            purgedLogs: purgeResult,
            warmupIncrements: warmupResult,
          }),
          "EX",
          86400
        );
      } catch {}
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}

/**
 * 7. SELF WARM-UP POOL WORKER: rotates internal warm-up emails between user's own active inboxes
 */
export function startWarmupWorker() {
  return new Worker(
    QUEUE_NAMES.WARMUP,
    async () => {
      const startedAt = Date.now();
      const result = await runSelfWarmupTick();
      const durationMs = Date.now() - startedAt;

      logger.info(
        { ...result, durationMs },
        "Self warm-up pool tick completed"
      );

      try {
        const redis = getRedisConnection();
        await redis.set(
          "leadreach:worker:last_run:warmup",
          JSON.stringify({
            jobType: "warmup-pool",
            timestamp: new Date().toISOString(),
            durationMs,
            ...result,
          }),
          "EX",
          86400
        );
      } catch {}
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}

import { startLeadSearchWorker } from "./lead-search-worker";

/**
 * Initializes and starts all Lead Reach AI background workers:
 * 1. Planner (computes scheduled social runs)
 * 2. Social Publish (executes social media posts)
 * 3. Email Dispatch (outreach loop & followup sequences)
 * 4. Email Send (transports single recipient emails)
 * 5. Reply Poll (IMAP inboxes for stop-on-reply, bounces & self warm-up replies)
 * 6. Maintenance (archives old usage counters)
 * 7. Lead Search (scrapes, enriches & deduplicates leads)
 * 8. Self Warm-up Pool (internal inbox warm-up between user accounts)
 */
export function startAllWorkers() {
  logger.info("Starting all Lead Reach AI background workers...");
  const planner = startPlannerWorker();
  const social = startSocialPublishWorker();
  const emailDispatch = startEmailDispatchWorker();
  const emailSend = startEmailSendWorker();
  const replyPoll = startReplyPollWorker();
  const maintenance = startMaintenanceWorker();
  const leadSearch = startLeadSearchWorker();
  const warmup = startWarmupWorker();

  logger.info("All 8 Lead Reach AI background workers are active.");
  return { planner, social, emailDispatch, emailSend, replyPoll, maintenance, leadSearch, warmup };
}


