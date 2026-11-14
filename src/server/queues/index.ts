import { Queue } from "bullmq";
import IORedis from "ioredis";
import { logger } from "@/server/logger";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let sharedConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    sharedConnection.on("error", (err) => {
      logger.warn({ err }, "Redis connection error (worker/queue degraded until connected)");
    });
  }
  return sharedConnection;
}

export const QUEUE_NAMES = {
  PLANNER: "planner",
  SOCIAL_PUBLISH: "social-publish",
  LEAD_SEARCH: "lead-search",
  LEAD_ENRICH: "lead-enrich",
  EMAIL_DISPATCH: "email-dispatch",
  EMAIL_SEND: "email-send",
  REPLY_POLL: "reply-poll",
  MAINTENANCE: "maintenance",
} as const;

export function createQueue(name: string): Queue {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}

let socialPublishQueue: Queue | null = null;
export function getSocialPublishQueue(): Queue {
  if (!socialPublishQueue) {
    socialPublishQueue = createQueue(QUEUE_NAMES.SOCIAL_PUBLISH);
  }
  return socialPublishQueue;
}

export async function queueSocialPublish(postRunId: string): Promise<boolean> {
  try {
    const queue = getSocialPublishQueue();
    await queue.add(
      "publish",
      { postRunId },
      {
        jobId: postRunId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      }
    );
    return true;
  } catch (err) {
    logger.warn({ err, postRunId }, "Failed to enqueue social publish job to Redis BullMQ");
    return false;
  }
}

let leadSearchQueue: Queue | null = null;
export function getLeadSearchQueue(): Queue {
  if (!leadSearchQueue) {
    leadSearchQueue = createQueue(QUEUE_NAMES.LEAD_SEARCH);
  }
  return leadSearchQueue;
}

export async function queueLeadSearch(searchId: string): Promise<boolean> {
  try {
    const queue = getLeadSearchQueue();
    await queue.add(
      "search",
      { searchId },
      {
        jobId: searchId,
        attempts: 2,
        backoff: { type: "exponential", delay: 3000 },
      }
    );
    return true;
  } catch (err) {
    logger.warn({ err, searchId }, "Failed to enqueue lead search job to Redis BullMQ");
    return false;
  }
}

let emailDispatchQueue: Queue | null = null;
export function getEmailDispatchQueue(): Queue {
  if (!emailDispatchQueue) {
    emailDispatchQueue = createQueue(QUEUE_NAMES.EMAIL_DISPATCH);
  }
  return emailDispatchQueue;
}

export async function queueEmailDispatch(campaignId?: string): Promise<boolean> {
  try {
    const queue = getEmailDispatchQueue();
    await queue.add(
      "dispatch",
      { campaignId, triggeredAt: new Date().toISOString() },
      {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      }
    );
    return true;
  } catch (err) {
    logger.warn({ err, campaignId }, "Failed to enqueue email dispatch job to Redis BullMQ");
    return false;
  }
}

let emailSendQueue: Queue | null = null;
export function getEmailSendQueue(): Queue {
  if (!emailSendQueue) {
    emailSendQueue = createQueue(QUEUE_NAMES.EMAIL_SEND);
  }
  return emailSendQueue;
}

export async function queueEmailSend(recipientId: string, delayMs = 0): Promise<boolean> {
  try {
    const queue = getEmailSendQueue();
    await queue.add(
      "send",
      { recipientId },
      {
        jobId: `send_${recipientId}_${Date.now()}`,
        delay: delayMs,
        attempts: 3,
        backoff: { type: "exponential", delay: 10000 },
      }
    );
    return true;
  } catch (err) {
    logger.warn({ err, recipientId }, "Failed to enqueue email send job to Redis BullMQ");
    return false;
  }
}

let plannerQueue: Queue | null = null;
export function getPlannerQueue(): Queue {
  if (!plannerQueue) {
    plannerQueue = createQueue(QUEUE_NAMES.PLANNER);
  }
  return plannerQueue;
}

let replyPollQueue: Queue | null = null;
export function getReplyPollQueue(): Queue {
  if (!replyPollQueue) {
    replyPollQueue = createQueue(QUEUE_NAMES.REPLY_POLL);
  }
  return replyPollQueue;
}

let maintenanceQueue: Queue | null = null;
export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = createQueue(QUEUE_NAMES.MAINTENANCE);
  }
  return maintenanceQueue;
}

/**
 * Registers BullMQ repeatable job schedulers for planner, email dispatch, reply polling, and maintenance.
 * - Idempotent: uses upsertJobScheduler (safe on restarts, updates in place)
 * - Safe-start switch: ONLY registered when process.env.SCHEDULERS_ENABLED === 'true'
 */
export async function registerRepeatableSchedulers(): Promise<{ registered: boolean; schedulers: string[] }> {
  const schedulersEnabled = process.env.SCHEDULERS_ENABLED === "true";
  if (!schedulersEnabled) {
    logger.info("Schedulers are DISABLED (SCHEDULERS_ENABLED is not 'true'). Repeatable jobs will not be registered.");
    return { registered: false, schedulers: [] };
  }

  const registered: string[] = [];
  logger.info("Registering BullMQ repeatable job schedulers (SCHEDULERS_ENABLED=true)...");

  // 1. Planner: every 60 seconds (1 minute)
  try {
    const q = getPlannerQueue();
    await q.upsertJobScheduler(
      "leadreach:scheduler:planner",
      { every: 60 * 1000 },
      { name: "planner-tick", data: {} }
    );
    registered.push("planner (every 60s)");
    logger.info("Registered repeatable scheduler: planner (every 60s)");
  } catch (err) {
    logger.error({ err }, "Failed to register planner job scheduler");
  }

  // 2. Email Dispatch: every 60 seconds (1 minute)
  try {
    const q = getEmailDispatchQueue();
    await q.upsertJobScheduler(
      "leadreach:scheduler:email-dispatch",
      { every: 60 * 1000 },
      { name: "email-dispatch-tick", data: {} }
    );
    registered.push("email-dispatch (every 60s)");
    logger.info("Registered repeatable scheduler: email-dispatch (every 60s)");
  } catch (err) {
    logger.error({ err }, "Failed to register email-dispatch job scheduler");
  }

  // 3. Reply Poll: every 300 seconds (5 minutes)
  try {
    const q = getReplyPollQueue();
    await q.upsertJobScheduler(
      "leadreach:scheduler:reply-poll",
      { every: 5 * 60 * 1000 },
      { name: "reply-poll-tick", data: {} }
    );
    registered.push("reply-poll (every 5m)");
    logger.info("Registered repeatable scheduler: reply-poll (every 5m)");
  } catch (err) {
    logger.error({ err }, "Failed to register reply-poll job scheduler");
  }

  // 4. Maintenance: daily at 02:00 UTC
  try {
    const q = getMaintenanceQueue();
    await q.upsertJobScheduler(
      "leadreach:scheduler:maintenance",
      { pattern: "0 2 * * *" },
      { name: "maintenance-daily", data: {} }
    );
    registered.push("maintenance (daily 02:00 UTC)");
    logger.info("Registered repeatable scheduler: maintenance (daily 02:00 UTC)");
  } catch (err) {
    logger.error({ err }, "Failed to register maintenance job scheduler");
  }

  return { registered: true, schedulers: registered };
}



