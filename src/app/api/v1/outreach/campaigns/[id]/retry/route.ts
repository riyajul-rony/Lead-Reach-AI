import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { queueEmailDispatch } from "@/server/queues";
import { assertTrialActive, isTrialExpiredError } from "@/server/billing/trial";
import { trialExpiredJsonResponse } from "@/server/billing/trial-response";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await assertTrialActive(session.user.id);
  } catch (err) {
    if (isTrialExpiredError(err)) {
      return trialExpiredJsonResponse(err);
    }
    throw err;
  }

  const { id } = await params;
  const campaign = await db.outreach_campaigns.findFirst({
    where: { id, user_id: session.user.id },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Find recipients with status: 'failed' or 'needs_review'
  const retryableRecipients = await db.campaign_recipients.findMany({
    where: {
      campaign_id: id,
      user_id: session.user.id,
      status: { in: ["failed", "needs_review"] },
    },
    select: {
      id: true,
      sent_at: true,
      last_sent_at: true,
      current_step: true,
      next_followup_at: true,
      thread_message_id: true,
    },
  });

  if (retryableRecipients.length === 0) {
    return NextResponse.json({
      success: true,
      retriedCount: 0,
      message: "No failed or needs_review recipients found to retry",
    });
  }

  const now = new Date();
  const initialIds: string[] = [];
  const followupDueIds: string[] = [];
  const followupFutureIds: string[] = [];

  for (const r of retryableRecipients) {
    const alreadySentPriorStep =
      Boolean(r.sent_at || r.last_sent_at || r.thread_message_id) ||
      (r.current_step || 0) > 0;

    if (!alreadySentPriorStep) {
      initialIds.push(r.id);
    } else if (r.next_followup_at && new Date(r.next_followup_at) > now) {
      followupFutureIds.push(r.id);
    } else {
      followupDueIds.push(r.id);
    }
  }

  // Never sent yet -> return to 'queued' for initial email dispatch
  if (initialIds.length > 0) {
    await db.campaign_recipients.updateMany({
      where: {
        campaign_id: id,
        user_id: session.user.id,
        id: { in: initialIds },
        status: { in: ["failed", "needs_review"] },
      },
      data: {
        status: "queued",
        error: null,
      },
    });
  }

  // Already sent step 0/1+ -> restore 'sent' status (preserving current_step) so sequence-service handles the next step
  if (followupDueIds.length > 0) {
    await db.campaign_recipients.updateMany({
      where: {
        campaign_id: id,
        user_id: session.user.id,
        id: { in: followupDueIds },
        status: { in: ["failed", "needs_review"] },
      },
      data: {
        status: "sent",
        error: null,
        next_followup_at: now,
      },
    });
  }

  if (followupFutureIds.length > 0) {
    await db.campaign_recipients.updateMany({
      where: {
        campaign_id: id,
        user_id: session.user.id,
        id: { in: followupFutureIds },
        status: { in: ["failed", "needs_review"] },
      },
      data: {
        status: "sent",
        error: null,
      },
    });
  }

  // If campaign is running, enqueue email dispatch immediately
  if (campaign.status === "running") {
    queueEmailDispatch(campaign.id).catch(() => null);
  }

  return NextResponse.json({
    success: true,
    retriedCount: retryableRecipients.length,
    initialRequeued: initialIds.length,
    followupsRestored: followupDueIds.length + followupFutureIds.length,
    message: `Successfully re-queued ${retryableRecipients.length} recipient(s).`,
  });
}
