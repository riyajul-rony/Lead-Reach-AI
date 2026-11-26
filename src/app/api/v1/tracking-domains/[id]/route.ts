import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import {
  deleteTrackingDomain,
  setDefaultTrackingDomain,
} from "@/server/email/tracking-domain-service";

export async function PATCH(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const updated = await setDefaultTrackingDomain(session.user.id, id);
    return NextResponse.json({ data: updated });
  } catch (err: any) {
    const msg = err?.message || "Failed to update tracking domain";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const res = await deleteTrackingDomain(session.user.id, id);
    return NextResponse.json({ data: res });
  } catch (err: any) {
    const msg = err?.message || "Failed to delete tracking domain";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
