import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { validateEnv } from "@/server/env";

const globalForPrisma = globalThis as unknown as {
  prisma?: any;
  pgPool?: pg.Pool;
};

function createBuildStub(): any {
  const rejectFn = async () => {
    throw new Error("Build-phase DB stub: DATABASE_URL is not configured.");
  };
  const modelProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        return rejectFn;
      },
    }
  );
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === "$transaction" || prop === "$queryRaw" || prop === "$executeRaw") {
          return rejectFn;
        }
        return modelProxy;
      },
    }
  ) as unknown as PrismaClient;
}

function createClient(): any {
  validateEnv();
  const connString = process.env.DATABASE_URL;

  const isBuildPhase =
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build";

  if (!connString || connString.trim() === "") {
    if (isBuildPhase) {
      return createBuildStub();
    }
    throw new Error(
      "FATAL: DATABASE_URL environment variable is missing. Refusing to start without PostgreSQL."
    );
  }

  const pool =
    globalForPrisma.pgPool ??
    new pg.Pool({
      connectionString: connString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pgPool = pool;
  }

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const db: any = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export function scoped<T extends object>(userId: string, where?: T): T & { user_id: string } {
  return { ...(where ?? ({} as T)), user_id: userId };
}
