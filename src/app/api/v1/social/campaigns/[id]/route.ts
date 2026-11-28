import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { db, scoped } from "@/server/db";
import { assertTrialActive, isTrialExpiredError } from "@/server/billing/trial";
import { trialExpiredJsonResponse } from "@/server/billing/trial-response";

const patchSocialCampaignSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(["active", "paused", "ended"]).optional(),
    social_account_id: z.string().uuid().optional(),
    openai_key_id: z.string().uuid().nullable().optional(),
    business_category: z.string().max(200).nullable().optional(),
    business_name: z.string().max(200).nullable().optional(),
    business_description: z.string().max(5000).nullable().optional(),
    target_audience: z.string().max(2000).nullable().optional(),
    brand_voice: z.string().max(200).nullable().optional(),
    language: z.string().max(100).optional(),
    prompt: z.string().max(10000).nullable().optional(),
    image_style: z.string().max(200).nullable().optional(),
    caption_length: z.enum(["short", "medium", "long"]).optional(),
    emojis: z.boolean().optional(),
    hashtags_count: z.number().int().min(0).max(30).optional(),
    cta_text: z.string().max(500).nullable().optional(),
    text_model: z.string().max(100).nullable().optional(),
    image_model: z.string().max(100).nullable().optional(),
    post_times: z.array(z.string().max(20)).max(24).optional(),
    days_of_week: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    timezone: z.string().max(100).optional(),
    approval_mode: z.enum(["auto", "approve"]).optional(),
    approval_timeout_hours: z.number().int().min(1).max(720).optional(),
    approval_timeout_action: z.enum(["skip", "publish"]).optional(),
  })
  .strict();

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

  const parsed = patchSocialCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.status === "active") {
    try {
      await assertTrialActive(session.user.id);
    } catch (err) {
      if (isTrialExpiredError(err)) {
        return trialExpiredJsonResponse(err);
      }
      throw err;
    }
  }

  const existing = await db.social_campaigns.findFirst({
    where: scoped(session.user.id, { id }),
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (parsed.data.social_account_id) {
    const account = await db.social_accounts.findFirst({
      where: scoped(session.user.id, { id: parsed.data.social_account_id }),
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json(
        { error: "Social account not found or does not belong to you." },
        { status: 403 }
      );
    }
  }

  if (parsed.data.openai_key_id) {
    const key = await db.api_keys.findFirst({
      where: scoped(session.user.id, { id: parsed.data.openai_key_id }),
      select: { id: true },
    });
    if (!key) {
      return NextResponse.json(
        { error: "OpenAI API key not found or does not belong to you." },
        { status: 403 }
      );
    }
  }

  const updated = await db.social_campaigns.update({
    where: scoped(session.user.id, { id }),
    data: parsed.data,
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    await db.social_campaigns.delete({
      where: scoped(session.user.id, { id }),
    });
    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to delete campaign" }, { status: 500 });
  }
}
