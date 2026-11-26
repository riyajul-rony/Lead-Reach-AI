import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { AccountActionError, exportUserAccountData } from "@/server/account/gdpr-service";

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await exportUserAccountData(session.user.id);
    const json = JSON.stringify(payload, null, 2);

    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="leadreach-account-export.json"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    if (err instanceof AccountActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to export account data" }, { status: 500 });
  }
}
