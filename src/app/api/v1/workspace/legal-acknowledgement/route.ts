import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import {
  getCurrentLegalTermsVersion,
  getWorkspaceLegalAcknowledgementStatus,
  recordWorkspaceLegalAcknowledgement,
} from "@/server/legal/acknowledgement";

const acceptSchema = z.object({
  accepted: z.literal(true),
  termsVersion: z.string().trim().min(1).max(64).optional(),
});

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await getWorkspaceLegalAcknowledgementStatus(session.user.id);
  return NextResponse.json({ data: status });
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "You must confirm the compliance acknowledgement checkbox to proceed." },
      { status: 400 }
    );
  }

  const currentVersion = getCurrentLegalTermsVersion();
  const requestedVersion = parsed.data.termsVersion;
  if (requestedVersion && requestedVersion !== currentVersion) {
    return NextResponse.json(
      {
        error: "Terms version mismatch. Please refresh and accept the latest terms version.",
        termsVersion: currentVersion,
      },
      { status: 422 }
    );
  }

  const saved = await recordWorkspaceLegalAcknowledgement(session.user.id, currentVersion);
  return NextResponse.json({ data: saved }, { status: 200 });
}
