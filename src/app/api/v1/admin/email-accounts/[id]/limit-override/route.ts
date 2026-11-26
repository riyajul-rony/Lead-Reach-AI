import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { getAdaptiveLimitConfig } from "@/server/email/adaptive-limit-config";
import { setAdminAccountDailyLimitOverride } from "@/server/email/adaptive-limit-service";

const overrideSchema = z.object({
  overrideLimit: z.number().int().nullable(),
  reason: z.string().trim().max(300).optional(),
});

export async function PATCH(
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

  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid override payload" },
      { status: 400 }
    );
  }

  const cfg = getAdaptiveLimitConfig();
  if (
    parsed.data.overrideLimit !== null &&
    (parsed.data.overrideLimit < cfg.floorLimit ||
      parsed.data.overrideLimit > cfg.systemMaxDailyLimit)
  ) {
    return NextResponse.json(
      {
        error: `Admin override limit must be between ${cfg.floorLimit} and ${cfg.systemMaxDailyLimit}.`,
      },
      { status: 400 }
    );
  }

  const { id } = await params;
  try {
    const res = await setAdminAccountDailyLimitOverride({
      adminId: session.user.id,
      accountId: id,
      overrideLimit: parsed.data.overrideLimit,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ data: res });
  } catch (err: any) {
    const msg = err?.message || "Failed to update daily limit override";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
