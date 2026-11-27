import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { db } from "@/server/db";

/**
 * Authenticated endpoint for a user to cancel auto-renewal on their own subscription.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let subscriptionId: string | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.subscriptionId === "string" && body.subscriptionId.trim()) {
      subscriptionId = body.subscriptionId.trim();
    }
  } catch {
    // Allow empty body; falls back to user's active subscription
  }

  const sub = subscriptionId
    ? await db.subscriptions.findFirst({
        where: {
          id: subscriptionId,
          user_id: session.user.id,
        },
      })
    : await db.subscriptions.findFirst({
        where: {
          user_id: session.user.id,
          status: { in: ["active", "trialing", "past_due"] },
        },
        orderBy: { created_at: "desc" },
      });

  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  await db.subscriptions.update({
    where: { id: sub.id },
    data: {
      cancel_at_period_end: true,
    },
  });

  return NextResponse.json({
    success: true,
    subscriptionId: sub.id,
    cancelAtPeriodEnd: true,
  });
}
