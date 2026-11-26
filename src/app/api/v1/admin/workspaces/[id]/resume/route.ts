import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { resumeWorkspaceSending } from "@/server/workspace/sending-control";

const resumeSchema = z.object({
  reason: z.string().trim().max(500).optional(),
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

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = resumeSchema.safeParse(body || {});

  const { id } = await params;
  try {
    const updated = await resumeWorkspaceSending({
      adminId: session.user.id,
      workspaceId: id,
      reason: parsed.success ? parsed.data.reason : undefined,
    });
    return NextResponse.json({ data: updated });
  } catch (err: any) {
    const msg = err?.message || "Failed to resume workspace sending";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
