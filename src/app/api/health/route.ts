import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { getRedisConnection } from "@/server/queues";
import { getSessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function isDetailedHealthAuthorized(req: NextRequest): Promise<boolean> {
  const configuredSecret =
    process.env.HEALTH_CHECK_SECRET?.trim() || process.env.CTD_TLS_ASK_SECRET?.trim();
  const providedSecret = req.headers.get("x-internal-health-secret")?.trim();
  if (configuredSecret && providedSecret && safeCompareSecret(providedSecret, configuredSecret)) {
    return true;
  }

  try {
    const session = await getSessionUser();
    if (session?.user?.role && hasPermission(session.user.role, "logs.read")) {
      return true;
    }
  } catch {
    // Ignore session lookup errors on healthcheck
  }

  return false;
}

export async function GET(req: NextRequest) {
  let dbOk = false;
  let redisOk = false;
  let dbLatency = 0;

  // 1. Check PostgreSQL
  const dbStart = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
    dbLatency = Date.now() - dbStart;
  } catch (err: any) {
    console.error("[Healthcheck] PostgreSQL check failed:", err?.message || err);
    dbOk = false;
  }

  // 2. Check Redis
  try {
    const redis = getRedisConnection();
    const pong = await redis.ping();
    redisOk = pong === "PONG";
  } catch (err: any) {
    console.error("[Healthcheck] Redis check failed:", err?.message || err);
    redisOk = false;
  }

  // 3. Check Worker Heartbeat
  let workerInfo: { status: "up" | "down" | "unknown"; lastHeartbeat: string | null; schedulersEnabled: boolean } = {
    status: "unknown",
    lastHeartbeat: null,
    schedulersEnabled: false,
  };
  if (redisOk) {
    try {
      const redis = getRedisConnection();
      const heartbeatRaw = await redis.get("leadreach:worker:heartbeat");
      if (heartbeatRaw) {
        const parsed = JSON.parse(heartbeatRaw);
        workerInfo = {
          status: "up",
          lastHeartbeat: parsed.timestamp || null,
          schedulersEnabled: Boolean(parsed.schedulersEnabled),
        };
      } else {
        workerInfo.status = "down";
      }
    } catch {}
  }

  const allHealthy = dbOk && redisOk;
  const includeDetails = await isDetailedHealthAuthorized(req);

  if (!includeDetails) {
    return NextResponse.json(
      { ok: allHealthy },
      { status: allHealthy ? 200 : 503 }
    );
  }

  return NextResponse.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      components: {
        database: { status: dbOk ? "up" : "down", latencyMs: dbLatency },
        redis: { status: redisOk ? "up" : "down" },
        worker: workerInfo,
      },
    },
    { status: allHealthy ? 200 : 503 }
  );
}
