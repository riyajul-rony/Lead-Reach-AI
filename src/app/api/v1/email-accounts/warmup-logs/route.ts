import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { listUserWarmupLogs } from "@/server/email/warmup-pool-service";

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const page = Number(req.nextUrl.searchParams.get("page") || "1");
  const limit = Number(req.nextUrl.searchParams.get("limit") || "15");

  const data = await listUserWarmupLogs(session.user.id, { page, limit });
  return NextResponse.json({ data });
}
