import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { isAdminRole } from "@/server/auth/permissions";
import { getAppUrl } from "@/server/config";
import { sendSystemMail } from "@/server/email/system-mailer";

const DAY_MS = 86_400_000;

export type PaidRenewalMilestone = "7d" | "3d" | "1d" | "expired";

function buildPaidRenewalContent(
  milestone: PaidRenewalMilestone,
  userName: string | null | undefined,
  planName: string,
  endsAt: Date,
  billingUrl: string
) {
  const greetingName = userName?.trim() || "there";
  const formattedEnd = endsAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (milestone === "expired") {
    return {
      title: `${planName} Plan Expired — Reverted to Free`,
      subject: `Your ${planName} plan has expired`,
      body: `Your ${planName} subscription expired on ${formattedEnd} and your account reverted to Free. Renew anytime on Billing to restore your paid quotas immediately.`,
      text: `Hi ${greetingName},\n\nYour ${planName} plan expired on ${formattedEnd} and your account has reverted to the Free tier.\n\nRenew your plan in Billing to restore your higher limits and automation immediately:\n${billingUrl}\n`,
      html: `<p>Hi ${greetingName},</p><p>Your <strong>${planName}</strong> plan expired on <strong>${formattedEnd}</strong> and your account has reverted to the Free tier.</p><p>Renew anytime to restore your paid quotas and automation immediately:</p><p><a href="${billingUrl}">Renew Your Plan</a></p>`,
    };
  }

  const daysText = milestone === "1d" ? "1 day" : milestone === "3d" ? "3 days" : "7 days";
  return {
    title: `Plan Renewal Reminder (${daysText} left)`,
    subject: `Your ${planName} plan renews in ${daysText}`,
    body: `Your ${planName} plan expires on ${formattedEnd} (${daysText} remaining). Submit a manual renewal payment on Billing to keep your campaigns running uninterrupted.`,
    text: `Hi ${greetingName},\n\nYour ${planName} plan will expire on ${formattedEnd} (${daysText} left).\n\nSubmit a manual renewal payment in Billing to extend from your current period end without any interruption:\n${billingUrl}\n`,
    html: `<p>Hi ${greetingName},</p><p>Your <strong>${planName}</strong> plan will expire on <strong>${formattedEnd}</strong> (${daysText} left).</p><p>Submit a manual renewal payment in Billing to extend from your current period end without interruption:</p><p><a href="${billingUrl}">Renew Your Plan</a></p>`,
  };
}

async function dispatchPaidRenewalMilestone(
  sub: any,
  milestone: PaidRenewalMilestone,
  billingUrl: string
): Promise<{ noticeCreated: boolean; emailSent: boolean }> {
  let noticeCreated = false;
  let emailSent = false;

  const user = await db.users
    .findUnique({
      where: { id: sub.user_id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        email_verified_at: true,
      },
    })
    .catch(() => null);

  if (!user || isAdminRole(user.role)) {
    return { noticeCreated, emailSent };
  }

  const plan = sub.plan_id
    ? await db.plans.findUnique({ where: { id: sub.plan_id }, select: { id: true, name: true, slug: true, monthly_price: true } }).catch(() => null)
    : null;

  if (!plan || plan.slug === "free") {
    return { noticeCreated, emailSent };
  }

  const endsAt = new Date(sub.current_period_end);
  const endDayStr = endsAt.toISOString().slice(0, 10);
  const noticeType = `paid_sub_notice_${milestone}_${sub.id}_${endDayStr}`;
  const emailMarkerType = `paid_sub_reminder_${milestone}_${sub.id}_${endDayStr}`;
  const content = buildPaidRenewalContent(milestone, user.name, plan.name, endsAt, billingUrl);

  // 1. Idempotent in-app notification
  const notifApi = (db as any).notifications;
  if (notifApi?.findFirst && notifApi?.create) {
    const existingNotif = await notifApi
      .findFirst({ where: { user_id: sub.user_id, type: noticeType } })
      .catch(() => null);

    if (!existingNotif) {
      const created = await notifApi
        .create({
          data: {
            user_id: sub.user_id,
            type: noticeType,
            title: content.title,
            body: content.body,
            entity_type: "subscription",
            entity_id: sub.id,
          },
        })
        .catch(() => null);
      if (created) noticeCreated = true;
    }
  }

  // 2. Email ONLY to verified addresses, idempotently
  if (!user.email_verified_at || !user.email) {
    return { noticeCreated, emailSent };
  }

  const existingMarkers = await db.activity_logs
    .findMany({
      where: { user_id: user.id, type: emailMarkerType },
      take: 1,
    })
    .catch(() => []);

  if (existingMarkers.length > 0) {
    return { noticeCreated, emailSent };
  }

  try {
    const mailRes = await sendSystemMail({
      to: user.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });

    if (!mailRes?.ok) {
      logger.warn(
        { userId: user.id, subId: sub.id, milestone, err: mailRes?.error },
        "Paid renewal reminder email delivery failed; continuing maintenance"
      );
      return { noticeCreated, emailSent };
    }

    await db.activity_logs
      .create({
        data: {
          user_id: user.id,
          type: emailMarkerType,
          message: `Paid plan ${milestone} renewal email sent to ${user.email}.`,
          meta: { subscriptionId: sub.id, planId: plan.id, milestone, expiresAt: endsAt.toISOString() },
        },
      })
      .catch((err: any) => {
        logger.warn(
          { userId: user.id, subId: sub.id, milestone, err: err?.message },
          "Failed to persist paid renewal reminder idempotency marker"
        );
      });

    emailSent = true;
  } catch (err: any) {
    logger.warn(
      { userId: user.id, subId: sub.id, milestone, err: err?.message },
      "Paid renewal reminder email threw; continuing maintenance"
    );
  }

  return { noticeCreated, emailSent };
}

/**
 * Checks and expires overdue subscriptions, reverting tenants to the Free plan.
 */
export async function expireOverdueSubscriptions(now: Date = new Date()): Promise<{ expiredCount: number }> {
  // Find all active or past_due subscriptions that passed their expiration date
  const overdueSubs = await db.subscriptions.findMany({
    where: {
      status: { in: ["active", "past_due"] },
      current_period_end: { lt: now },
    },
  }).catch(() => []);

  let expiredCount = 0;
  const freePlan = await db.plans.findUnique({ where: { slug: "free" } }).catch(() => null);
  const appUrl = (await getAppUrl().catch(() => "http://localhost:3000")).replace(/\/$/, "");
  const billingUrl = `${appUrl}/app/settings/billing`;

  for (const sub of overdueSubs) {
    try {
      // 1. Mark subscription as expired
      await db.subscriptions.update({
        where: { id: sub.id },
        data: { status: "expired" },
      });

      // 2. Revert user to free plan
      await db.users.update({
        where: { id: sub.user_id },
        data: {
          plan: "free",
          plan_id: freePlan?.id || null,
        },
      });

      // 3. Dispatch idempotent expiry notice & verified-only email for paid plans
      if (sub.provider !== "trial") {
        await dispatchPaidRenewalMilestone(sub, "expired", billingUrl);
      }

      expiredCount++;
    } catch (err: any) {
      logger.error({ subId: sub.id, err: err.message }, "Failed to expire subscription");
    }
  }

  return { expiredCount };
}

/**
 * Checks active paid subscriptions expiring within 7, 3, or 1 days and sends idempotent reminder notices & verified emails.
 */
export async function sendRenewalReminders(now: Date = new Date()): Promise<{
  remindersSent: number;
  emailsSent: number;
  noticesCreated: number;
}> {
  const sevenDaysFromNow = new Date(now.getTime() + 7 * DAY_MS);

  const expiringSubs = await db.subscriptions
    .findMany({
      where: {
        status: "active",
        provider: { not: "trial" },
        current_period_end: {
          gte: now,
          lte: sevenDaysFromNow,
        },
      },
    })
    .catch(() => []);

  const appUrl = (await getAppUrl().catch(() => "http://localhost:3000")).replace(/\/$/, "");
  const billingUrl = `${appUrl}/app/settings/billing`;

  let noticesCreated = 0;
  let emailsSent = 0;

  for (const sub of expiringSubs) {
    try {
      if (sub.provider === "trial") continue;

      const endsAt = new Date(sub.current_period_end);
      const msLeft = endsAt.getTime() - now.getTime();
      if (msLeft <= 0) continue;

      const daysLeft = Math.ceil(msLeft / DAY_MS);
      let milestone: PaidRenewalMilestone | null = null;
      if (daysLeft === 1) {
        milestone = "1d";
      } else if (daysLeft <= 3) {
        milestone = "3d";
      } else if (daysLeft <= 7) {
        milestone = "7d";
      }

      if (!milestone) continue;

      const res = await dispatchPaidRenewalMilestone(sub, milestone, billingUrl);
      if (res.noticeCreated) noticesCreated++;
      if (res.emailSent) emailsSent++;
    } catch (err: any) {
      logger.warn({ subId: sub.id, err: err.message }, "Failed to process paid renewal reminder");
    }
  }

  return {
    remindersSent: noticesCreated + emailsSent,
    emailsSent,
    noticesCreated,
  };
}

/**
 * Combined subscription lifecycle worker execution
 */
export async function processSubscriptionLifecycles(now: Date = new Date()) {
  const { expiredCount } = await expireOverdueSubscriptions(now);
  const { remindersSent, emailsSent, noticesCreated } = await sendRenewalReminders(now);
  return { expiredCount, remindersSent, emailsSent, noticesCreated };
}
