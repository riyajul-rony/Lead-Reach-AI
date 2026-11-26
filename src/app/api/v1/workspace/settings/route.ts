import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import {
  getOrCreateDefaultWorkspace,
  resolveUserWorkspaceBusinessAddress,
  updateWorkspaceBusinessAddress,
} from "@/server/workspace/settings";

const patchSchema = z.object({
  business_address: z.string().trim().max(500).nullable().optional(),
});

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ws = await getOrCreateDefaultWorkspace(session.user.id);
  const resolvedAddress =
    ws.business_address?.trim() ||
    (await resolveUserWorkspaceBusinessAddress(session.user.id)) ||
    "";

  return NextResponse.json({
    data: {
      id: ws.id,
      name: ws.name,
      business_address: resolvedAddress,
    },
  });
}

export async function PATCH(req: NextRequest) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 }
    );
  }

  const updated = await updateWorkspaceBusinessAddress(
    session.user.id,
    parsed.data.business_address ?? null
  );

  return NextResponse.json({ data: updated });
}
