import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getScrapeQueueStatus } from "@/server/providers/leads/google-maps";

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = getScrapeQueueStatus();
  return NextResponse.json({
    status: status.isBusy ? "busy" : "idle",
    queued: status.queuedCount,
  });
}
