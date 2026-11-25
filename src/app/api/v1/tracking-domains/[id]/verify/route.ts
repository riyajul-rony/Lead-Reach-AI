import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { verifyTrackingDomainDns } from "@/server/email/tracking-domain-service";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const updated = await verifyTrackingDomainDns(session.user.id, id);
    return NextResponse.json({ data: updated });
  } catch (err: any) {
    const msg = err?.message || "Verification failed";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
