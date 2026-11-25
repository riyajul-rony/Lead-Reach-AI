import crypto from "node:crypto";
import { db } from "@/server/db";

export interface VariantInput {
  step_no?: number;
  label: string;
  subject_template?: string;
  body_template?: string;
  weight?: number;
  is_active?: boolean;
}

export interface CampaignVariantRecord {
  id: string;
  campaign_id: string;
  step_no: number;
  label: string;
  subject_template: string | null;
  body_template: string | null;
  weight: number;
  is_active: boolean;
}

export interface VariantPerformanceStat {
  id: string;
  step_no: number;
  label: string;
  weight: number;
  is_active: boolean;
  subject_template: string | null;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: string;
  clickRate: string;
  replyRate: string;
}

/**
 * Validates that every variant has a strictly positive integer weight (> 0) and non-empty label.
 */
export function validateVariantInputs(variants: VariantInput[]): void {
  for (const v of variants) {
    if (!v.label || !String(v.label).trim()) {
      throw new Error("Variant label is required");
    }
    const weight = v.weight ?? 50;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Invalid weight for variant '${v.label}': weight must be greater than 0`);
    }
  }
}

/**
 * Selects an active variant deterministically and evenly (weighted) for a campaign step + recipient.
 * If recipient.variant_id is already assigned for step 0, preserves that assignment (safe across retries).
 * Returns null when the campaign step has no A/B variants configured (100% backwards-compatible).
 */
export async function selectVariantForRecipient(
  campaignId: string,
  stepNo: number,
  recipient: { id: string; variant_id?: string | null }
): Promise<CampaignVariantRecord | null> {
  if (!db.campaign_variants?.findMany) {
    return null;
  }

  const allStepVariants: CampaignVariantRecord[] = await db.campaign_variants.findMany({
    where: { campaign_id: campaignId, step_no: stepNo },
    orderBy: { label: "asc" },
  });

  if (!allStepVariants || allStepVariants.length === 0) {
    return null;
  }

  // Preserve previously assigned variant on step 0 (e.g. after Phase 2 retry)
  if (stepNo === 0 && recipient.variant_id) {
    const existing = allStepVariants.find((v) => v.id === recipient.variant_id);
    if (existing) {
      return existing;
    }
  }

  const activeVariants = allStepVariants.filter((v) => v.is_active !== false && (v.weight ?? 0) > 0);
  if (activeVariants.length === 0) {
    return null;
  }

  if (activeVariants.length === 1) {
    return activeVariants[0];
  }

  const totalWeight = activeVariants.reduce((sum, v) => sum + Math.max(1, Math.floor(v.weight || 1)), 0);
  const digest = crypto
    .createHash("sha256")
    .update(`${campaignId}:${stepNo}:${recipient.id}`)
    .digest();
  const bucket = digest.readUInt32BE(0) % totalWeight;

  let cursor = 0;
  for (const variant of activeVariants) {
    cursor += Math.max(1, Math.floor(variant.weight || 1));
    if (bucket < cursor) {
      return variant;
    }
  }

  return activeVariants[0];
}

/**
 * Computes per-variant sent, opened, clicked, and replied analytics for a campaign.
 * Uses tracking_events and email_messages so metrics remain accurate even across multiple steps.
 */
export async function getCampaignVariantStats(campaignId: string): Promise<VariantPerformanceStat[]> {
  if (!db.campaign_variants?.findMany) {
    return [];
  }

  const variants: CampaignVariantRecord[] = await db.campaign_variants.findMany({
    where: { campaign_id: campaignId },
    orderBy: { label: "asc" },
  });

  if (!variants || variants.length === 0) {
    return [];
  }

  const recipients = await db.campaign_recipients.findMany({
    where: { campaign_id: campaignId },
    select: {
      id: true,
      variant_id: true,
      status: true,
      open_count: true,
      click_count: true,
    },
    take: 5000,
  });

  const recipientIds = recipients.map((r: any) => r.id);
  const sentMessages =
    recipientIds.length > 0 && db.email_messages?.findMany
      ? await db.email_messages.findMany({
          where: {
            recipient_id: { in: recipientIds },
            direction: "out",
            status: "sent",
            variant_id: { not: null },
          },
          select: {
            recipient_id: true,
            variant_id: true,
          },
          take: 10000,
        })
      : [];

  const trackingEvents = db.tracking_events?.findMany
    ? await db.tracking_events.findMany({
        where: { campaign_id: campaignId, variant_id: { not: null } },
        select: { recipient_id: true, variant_id: true, event_type: true },
        take: 10000,
      })
    : [];

  const recipientMap = new Map<string, any>(recipients.map((r: any) => [r.id, r]));

  return variants.map((v) => {
    const sentRecipientSet = new Set<string>();
    for (const m of sentMessages) {
      if (m.variant_id === v.id && m.recipient_id) {
        sentRecipientSet.add(m.recipient_id);
      }
    }
    // Fallback for recipients directly linked via variant_id whose message might not carry variant_id
    for (const r of recipients) {
      if (r.variant_id === v.id && r.status !== "queued" && r.status !== "failed") {
        sentRecipientSet.add(r.id);
      }
    }

    const openedSet = new Set<string>();
    const clickedSet = new Set<string>();
    for (const ev of trackingEvents) {
      if (ev.variant_id !== v.id) continue;
      if (ev.event_type === "open" && ev.recipient_id) openedSet.add(ev.recipient_id);
      if (ev.event_type === "click" && ev.recipient_id) clickedSet.add(ev.recipient_id);
    }

    // Fallback to recipient counters when variant_id matches (step 0 single tracking)
    for (const r of recipients) {
      if (r.variant_id === v.id) {
        if ((r.open_count || 0) > 0) openedSet.add(r.id);
        if ((r.click_count || 0) > 0) clickedSet.add(r.id);
      }
    }

    let repliedCount = 0;
    for (const rid of sentRecipientSet) {
      const r = recipientMap.get(rid);
      if (r?.status === "replied") {
        repliedCount++;
      }
    }

    const sent = sentRecipientSet.size;
    const opened = openedSet.size;
    const clicked = clickedSet.size;
    const replied = repliedCount;

    return {
      id: v.id,
      step_no: v.step_no,
      label: v.label,
      weight: v.weight,
      is_active: v.is_active,
      subject_template: v.subject_template,
      sent,
      opened,
      clicked,
      replied,
      openRate: sent > 0 ? ((opened / sent) * 100).toFixed(1) : "0.0",
      clickRate: sent > 0 ? ((clicked / sent) * 100).toFixed(1) : "0.0",
      replyRate: sent > 0 ? ((replied / sent) * 100).toFixed(1) : "0.0",
    };
  });
}
