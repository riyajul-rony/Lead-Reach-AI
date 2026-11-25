import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { VALID_REPLY_CATEGORIES } from "@/server/ai/reply-classifier";

const overrideSchema = z.object({
  category: z.enum(VALID_REPLY_CATEGORIES),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid reply category" }, { status: 400 });
  }

  const existing = await db.email_messages.findFirst({
    where: {
      id,
      user_id: session.user.id,
      direction: "in",
    },
    select: {
      id: true,
      recipient_id: true,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Reply message not found" }, { status: 404 });
  }

  const updated = await db.email_messages.update({
    where: { id: existing.id },
    data: {
      reply_category: parsed.data.category,
      reply_category_source: "manual",
      reply_category_confidence: 1,
    },
  });

  if (existing.recipient_id) {
    await db.campaign_recipients
      .update({
        where: { id: existing.recipient_id },
        data: { reply_category: parsed.data.category },
      })
      .catch(() => null);
  }

  return NextResponse.json({
    success: true,
    data: {
      id: updated.id,
      reply_category: parsed.data.category,
      reply_category_source: "manual",
    },
  });
}
