import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { db, scoped } from "@/server/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const postRun = await db.post_runs.findFirst({
    where: scoped(session.user.id, { id }),
  });

  if (!postRun) {
    return NextResponse.json({ error: "Post run not found" }, { status: 404 });
  }

  // Reset status to pending_approval and schedule for now so the user can approve or publish it
  const updated = await db.post_runs.update({
    where: scoped(session.user.id, { id }),
    data: {
      status: "pending_approval",
      error_message: null,
      scheduled_for: new Date(),
    },
  });

  return NextResponse.json({
    success: true,
    data: updated,
    message: "Post rescheduled and ready for approval or publishing.",
  });
}
