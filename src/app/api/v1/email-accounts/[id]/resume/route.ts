import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { resumePausedEmailAccount } from "@/server/email/deliverability-pause";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const updated = await resumePausedEmailAccount(session.user.id, id);
    const {
      smtp_password_enc,
      imap_password_enc,
      oauth_access_token_enc,
      oauth_refresh_token_enc,
      ...safe
    } = updated as any;
    void smtp_password_enc;
    void imap_password_enc;
    void oauth_access_token_enc;
    void oauth_refresh_token_enc;

    return NextResponse.json({ data: safe });
  } catch (err: any) {
    const msg = err?.message || "Failed to resume email account";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
