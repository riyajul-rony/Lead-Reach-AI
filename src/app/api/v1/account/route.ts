import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/server/auth/session";
import { AccountActionError, deleteOwnAccount } from "@/server/account/gdpr-service";
import { logger } from "@/server/logger";

export async function DELETE(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { password?: string; confirmation?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    await deleteOwnAccount(session.user.id, {
      password: body.password,
      confirmation: body.confirmation,
    });

    const res = NextResponse.json({
      success: true,
      message: "Your account and all associated data have been permanently deleted.",
    });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (err: any) {
    if (err instanceof AccountActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err: err?.message, userId: session.user.id }, "GDPR account deletion failed");
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
