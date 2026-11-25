import { validateEnv, areSchedulersEnabled } from "@/server/env";
import { startAllWorkers } from "./index";
import { registerRepeatableSchedulers, getRedisConnection } from "@/server/queues";
import { logger } from "@/server/logger";

// 1. Fail fast if essential services are not configured
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  logger.error("FATAL: Worker process cannot start. DATABASE_URL and REDIS_URL environment variables are required.");
  process.exit(1);
}

validateEnv();

logger.info("Lead Reach AI Worker Supervisor starting...");
const workers = startAllWorkers();

// 2. Heartbeat to Redis every 30 seconds
const writeHeartbeat = async () => {
  try {
    const redis = getRedisConnection();
    const payload = JSON.stringify({
      status: "alive",
      pid: process.pid,
      timestamp: new Date().toISOString(),
      schedulersEnabled: areSchedulersEnabled(),
      uptimeSec: Math.floor(process.uptime()),
    });
    await redis.set("leadreach:worker:heartbeat", payload, "EX", 120);
  } catch (err) {
    logger.warn({ err }, "Could not write worker heartbeat to Redis");
  }
};

writeHeartbeat();
const heartbeatInterval = setInterval(writeHeartbeat, 30000);

// 3. Register repeatable schedulers (idempotent, only when SCHEDULERS_ENABLED=true)
registerRepeatableSchedulers().catch((err) => {
  logger.error({ err }, "Failed to initialize repeatable job schedulers");
});

const shutdown = async (signal: string) => {
  clearInterval(heartbeatInterval);
  logger.info({ signal }, "Shutting down Lead Reach AI workers gracefully...");
  await Promise.allSettled(Object.values(workers).map((w) => w.close()));
  logger.info("All workers stopped. Exiting process.");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
