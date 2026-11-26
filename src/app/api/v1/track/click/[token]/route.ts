import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { verifySignedTrackingToken } from "@/server/email/tracking-token";

function extractUrlsFromText(text?: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>)\]}]+/gi) || [];
  return matches.map((u) => u.trim());
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  let targetUrl: string | null = null;
  let recipientLookupToken = token;

  // Verify HMAC-signed token or fallback to legacy query parameter
  if (token.includes(".")) {
    const verified = verifySignedTrackingToken(token);
    if (!verified) {
      return NextResponse.json({ error: "Invalid tracking token" }, { status: 404 });
    }
    targetUrl = verified.targetUrl;
    recipientLookupToken = verified.recipientToken;
  } else {
    targetUrl = req.nextUrl.searchParams.get("url")?.trim() || null;
  }

  // Validate redirect URL format and protocol strictly
  if (!targetUrl) {
    return NextResponse.json({ error: "Link not found" }, { status: 404 });
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ error: "Invalid link protocol" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid link URL" }, { status: 404 });
  }

  try {
    // 1. Resolve recipient and associated campaign
    const recipient = await db.campaign_recipients.findFirst({
      where: { unsubscribe_token: recipientLookupToken },
      include: {
        campaign: {
          include: {
            campaign_steps: true,
            variants: true,
          },
        },
      },
    });

    if (!recipient || !recipient.campaign) {
      return NextResponse.json({ error: "Link not found" }, { status: 404 });
    }

    // 2. Validate targetUrl against URLs actually stored in the DB for this campaign (including A/B variants)
    const allowedUrls = new Set<string>();

    for (const u of extractUrlsFromText(recipient.campaign.body_template)) {
      allowedUrls.add(normalizeUrl(u));
    }
    for (const step of recipient.campaign.campaign_steps || []) {
      for (const u of extractUrlsFromText(step.body_template)) {
        allowedUrls.add(normalizeUrl(u));
      }
    }
    for (const variant of recipient.campaign.variants || []) {
      for (const u of extractUrlsFromText(variant.body_template)) {
        allowedUrls.add(normalizeUrl(u));
      }
    }

    const vars = (recipient.vars as Record<string, unknown>) || {};
    for (const val of Object.values(vars)) {
      if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))) {
        allowedUrls.add(normalizeUrl(val));
      }
    }

    const normTarget = normalizeUrl(targetUrl);
    let isAllowed = allowedUrls.has(normTarget);

    if (!isAllowed) {
      // Check if URL was previously logged in tracking events for this campaign
      const existingEvent = await db.tracking_events.findFirst({
        where: {
          campaign_id: recipient.campaign_id,
          link_url: targetUrl,
        },
      }).catch(() => null);
      if (existingEvent) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return NextResponse.json({ error: "Unauthorized destination URL" }, { status: 404 });
    }

    // 3. Record tracking metrics if enabled
    if (recipient.campaign.tracking_click) {
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        null;
      const userAgent = req.headers.get("user-agent") || null;

      await db.campaign_recipients.update({
        where: { id: recipient.id },
        data: {
          click_count: { increment: 1 },
          first_clicked_at: recipient.first_clicked_at || new Date(),
          last_clicked_at: new Date(),
        },
      }).catch(() => null);

      try {
        if (db.tracking_events?.create) {
          await db.tracking_events.create({
            data: {
              recipient_id: recipient.id,
              campaign_id: recipient.campaign_id,
              variant_id: recipient.variant_id || null,
              event_type: "click",
              link_url: targetUrl,
              ip_address: ip,
              user_agent: userAgent,
            },
          });
        }
      } catch {}
    }

    // 4. Safe 302 Found redirect
    return NextResponse.redirect(targetUrl, 302);
  } catch {
    return NextResponse.json({ error: "Link processing error" }, { status: 404 });
  }
}
