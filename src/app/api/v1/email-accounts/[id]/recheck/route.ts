import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { runAccountProfileDetection } from "@/server/email/account-profile-detector";
import { getAccountAdaptiveLimitSummary } from "@/server/email/adaptive-limit-service";
import { getUtcDayStart } from "@/server/email/daily-capacity";

const recheckSchema = z.object({
  workspaceTier: z.enum(["trial", "paid"]).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const account = await db.email_accounts.findFirst({
    where: { id, user_id: session.user.id },
  });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = recheckSchema.safeParse(body || {});
  const workspaceTier = parsed.success ? parsed.data.workspaceTier : undefined;

  try {
    const result = await runAccountProfileDetection(id, {
      force: true,
      workspaceTier,
    });

    const utcStart = getUtcDayStart(new Date());
    const [sentToday, warmupLogs] = await Promise.all([
      db.email_messages?.count
        ? db.email_messages.count({
            where: {
              email_account_id: id,
              direction: "out",
              status: "sent",
              sent_at: { gte: utcStart },
            },
          })
        : Promise.resolve(0),
      db.warmup_logs?.findMany
        ? db.warmup_logs.findMany({
            where: {
              from_account_id: id,
              status: { in: ["sent", "replied"] },
              sent_at: { gte: utcStart },
            },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const adaptive = await getAccountAdaptiveLimitSummary(result.account, {
      campaignSentToday: sentToday,
      warmupSentToday: warmupLogs.length,
    });

    return NextResponse.json({
      data: {
        adaptive_limit: adaptive,
        warning: result.warning || null,
      },
    });
  } catch (err: any) {
    logger.error({ err: err?.message, accountId: id }, "Failed to re-check account profile");
    return NextResponse.json(
      { error: "Failed to re-check account profile" },
      { status: 500 }
    );
  }
}
