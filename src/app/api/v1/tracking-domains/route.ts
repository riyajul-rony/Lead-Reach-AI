import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import {
  createTrackingDomain,
  listTrackingDomains,
} from "@/server/email/tracking-domain-service";

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const page = Number(req.nextUrl.searchParams.get("page") || "1");
  const limit = Number(req.nextUrl.searchParams.get("limit") || "20");

  const data = await listTrackingDomains(session.user.id, { page, limit });
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const created = await createTrackingDomain(session.user.id, body?.domain || "");
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err: any) {
    const msg = err?.message || "Failed to add tracking domain";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
