import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { pauseWorkspaceSending } from "@/server/workspace/sending-control";

const pauseSchema = z.object({
  reason: z.string().trim().min(3, "Pause reason (at least 3 characters) is required").max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(session.user.role, "users.manage")) {
    return NextResponse.json(
      { error: "Forbidden: users.manage admin permission required" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = pauseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Pause reason is required" },
      { status: 400 }
    );
  }

  const { id } = await params;
  try {
    const updated = await pauseWorkspaceSending({
      adminId: session.user.id,
      workspaceId: id,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ data: updated });
  } catch (err: any) {
    const msg = err?.message || "Failed to pause workspace sending";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
