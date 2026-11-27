import { getRedisConnection } from "@/server/queues";

export interface WorkerSchedulerStatus {
  redisOk: boolean;
  workerUp: boolean;
  schedulersEnabled: boolean;
  lastHeartbeat: string | null;
  stale: boolean;
  warningMessage: string | null;
}

const HEARTBEAT_KEY = "leadreach:worker:heartbeat";
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Inspects the Redis worker heartbeat to report whether the background worker
 * is alive and repeatable BullMQ schedulers are enabled.
 */
export async function getWorkerSchedulerStatus(
  nowMs: number = Date.now()
): Promise<WorkerSchedulerStatus> {
  let redisOk = false;
  let workerUp = false;
  let schedulersEnabled = false;
  let lastHeartbeat: string | null = null;
  let stale = false;

  try {
    const redis = getRedisConnection();
    const pong = await redis.ping();
    redisOk = pong === "PONG";

    if (redisOk) {
      const raw = await redis.get(HEARTBEAT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          timestamp?: string;
          schedulersEnabled?: boolean;
        };
        lastHeartbeat = parsed.timestamp || null;
        schedulersEnabled = Boolean(parsed.schedulersEnabled);
        if (lastHeartbeat) {
          const ts = Date.parse(lastHeartbeat);
          stale = !Number.isFinite(ts) || nowMs - ts > STALE_HEARTBEAT_MS;
          workerUp = !stale;
        }
      }
    }
  } catch {
    redisOk = false;
  }

  let warningMessage: string | null = null;
  if (!redisOk) {
    warningMessage =
      "Redis is unreachable, so background worker heartbeat and repeatable schedulers cannot be verified.";
  } else if (!workerUp) {
    warningMessage = lastHeartbeat
      ? `Background worker heartbeat is stale (last seen ${lastHeartbeat}). Warm-up emails, campaign sending, and reply polling will not run until the worker is online.`
      : "No background worker heartbeat detected. Warm-up emails, campaign sending, and reply polling will not run until the worker service is started.";
  } else if (!schedulersEnabled) {
    warningMessage =
      "Background worker is online, but SCHEDULERS_ENABLED is false. Repeatable warm-up, campaign dispatch, and reply polling jobs are paused.";
  }

  return {
    redisOk,
    workerUp,
    schedulersEnabled,
    lastHeartbeat,
    stale,
    warningMessage,
  };
}
