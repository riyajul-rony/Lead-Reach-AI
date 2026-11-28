import { z } from "zod";
import { db } from "@/server/db";
import { getManualPaymentConfig, computeBdtAmount } from "@/server/billing/manual-settings";
import { recordAuditLog } from "@/server/audit";
import { sendSystemMail } from "@/server/email/system-mailer";
import { getAppUrl } from "@/server/config";
import { logger } from "@/server/logger";

export const MANUAL_PAYMENT_METHODS = ["bkash", "nagad", "bank"] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const manualSubmitSchema = z.object({
  paymentId: z.string().trim().min(1, "Payment ID is required").max(120),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  transactionId: z
    .string()
    .trim()
    .min(4, "Transaction ID must be at least 4 characters")
    .max(80, "Transaction ID must be at most 80 characters")
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "Transaction ID may only contain letters, numbers, hyphens, and underscores"
    ),
  senderNumber: z
    .string()
    .trim()
    .min(4, "Sender number / account must be at least 4 characters")
    .max(40, "Sender number / account must be at most 40 characters")
    .regex(
      /^[0-9+\-()\s]+$/,
      "Sender number may only contain digits, spaces, +, -, and parentheses"
    ),
  note: z
    .string()
    .trim()
    .max(500, "Note must be 500 characters or fewer")
    .optional()
    .or(z.literal("")),
});

export class ManualPaymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualPaymentError";
    this.status = status;
  }
}

export async function isDuplicateTransactionId(
  normalizedTrxId: string,
  excludePaymentId?: string
): Promise<boolean> {
  const existingByProviderId = await db.payments
    .findFirst({
      where: {
        ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
        provider_payment_id: { equals: normalizedTrxId, mode: "insensitive" },
      },
      select: { id: true },
    })
    .catch(() => null);

  if (existingByProviderId) return true;

  // Also check recent manual payments in case a legacy payment stored transaction_id in method_details
  const recentManual = await db.payments
    .findMany({
      where: {
        ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
        provider: "manual",
      },
      orderBy: { created_at: "desc" },
      take: 250,
      select: { id: true, provider_payment_id: true, method_details: true },
    })
    .catch(() => []);

  return recentManual.some((p: any) => {
    if (excludePaymentId && p.id === excludePaymentId) return false;
    const ppId = String(p.provider_payment_id || "").trim().toUpperCase();
    if (ppId && ppId === normalizedTrxId) return true;
    const details =
      p.method_details && typeof p.method_details === "object"
        ? (p.method_details as Record<string, unknown>)
        : {};
    const trx = String(details.transaction_id_normalized || details.transaction_id || "")
      .trim()
      .toUpperCase();
    return Boolean(trx && trx === normalizedTrxId);
  });
}

export async function submitManualPaymentDetails(input: {
  userId: string;
  paymentId: string;
  method: ManualPaymentMethod;
  transactionId: string;
  senderNumber: string;
  note?: string;
}) {
  const config = await getManualPaymentConfig();
  if (!config.isConfigured) {
    throw new ManualPaymentError("Manual payment is not set up yet.", 400);
  }

  if (input.method === "bkash" && !config.bkashNumber) {
    throw new ManualPaymentError("bKash payment is not currently configured.", 400);
  }
  if (input.method === "nagad" && !config.nagadNumber) {
    throw new ManualPaymentError("Nagad payment is not currently configured.", 400);
  }
  if (input.method === "bank" && !(config.bankName && config.bankAccountNumber)) {
    throw new ManualPaymentError("Bank transfer is not currently configured.", 400);
  }

  const payment = await db.payments.findUnique({
    where: { id: input.paymentId },
  });

  if (!payment || payment.user_id !== input.userId || payment.provider !== "manual") {
    throw new ManualPaymentError("Pending payment not found.", 404);
  }

  if (payment.status !== "pending") {
    throw new ManualPaymentError("This payment has already been reviewed.", 409);
  }

  const existingDetails =
    payment.method_details && typeof payment.method_details === "object"
      ? (payment.method_details as Record<string, any>)
      : {};

  if (existingDetails.submitted_at && existingDetails.transaction_id) {
    throw new ManualPaymentError(
      "Payment details have already been submitted and are waiting for review.",
      409
    );
  }

  const normalizedTrx = input.transactionId.trim().toUpperCase();
  const duplicate = await isDuplicateTransactionId(normalizedTrx, payment.id);
  if (duplicate) {
    throw new ManualPaymentError(
      "This Transaction ID has already been submitted for another payment.",
      409
    );
  }

  const now = new Date();
  const bdtAmount = computeBdtAmount(Number(payment.amount), config.usdToBdtRate);
  const updatedDetails = {
    ...existingDetails,
    method: input.method,
    transaction_id: input.transactionId.trim(),
    transaction_id_normalized: normalizedTrx,
    sender_number: input.senderNumber.trim(),
    user_note: input.note?.trim() || undefined,
    bdt_amount: bdtAmount ?? existingDetails.bdt_amount ?? null,
    usd_to_bdt_rate: config.usdToBdtRate ?? existingDetails.usd_to_bdt_rate ?? null,
    review_status: "waiting_review",
    submitted_at: now.toISOString(),
  };

  const updated = await db.payments.update({
    where: { id: payment.id },
    data: {
      provider_payment_id: normalizedTrx,
      method_details: updatedDetails,
    },
  });

  return {
    payment: updated,
    details: updatedDetails,
  };
}

const DAY_MS = 86_400_000;

export async function approveManualPayment(input: {
  paymentId: string;
  adminId: string;
  adminEmail: string;
}) {
  const payment = await db.payments.findUnique({ where: { id: input.paymentId } });
  if (!payment || payment.provider !== "manual") {
    throw new ManualPaymentError("Manual payment not found.", 404);
  }

  if (payment.status === "succeeded") {
    return { success: true, alreadyApproved: true, userId: payment.user_id, payment };
  }

  if (payment.status !== "pending") {
    throw new ManualPaymentError("Only pending payments can be approved.", 409);
  }

  const now = new Date();
  const claim = await db.payments.updateMany({
    where: { id: payment.id, status: "pending" },
    data: { status: "succeeded", paid_at: now },
  });

  if (claim.count === 0) {
    const reloaded = await db.payments.findUnique({ where: { id: payment.id } });
    if (reloaded?.status === "succeeded") {
      return { success: true, alreadyApproved: true, userId: reloaded.user_id, payment: reloaded };
    }
    throw new ManualPaymentError("Payment was already processed.", 409);
  }

  const details =
    payment.method_details && typeof payment.method_details === "object"
      ? (payment.method_details as Record<string, any>)
      : {};

  const existingSubs = await db.subscriptions
    .findMany({
      where: { user_id: payment.user_id },
      orderBy: { created_at: "desc" },
      take: 10,
    })
    .catch(() => []);

  const linkedSub = payment.subscription_id
    ? existingSubs.find((s: any) => s.id === payment.subscription_id)
    : null;
  const activeOrTrialSub = existingSubs.find((s: any) =>
    ["active", "trialing", "past_due"].includes(s.status)
  );
  const subToUpdate = activeOrTrialSub || linkedSub || null;

  const targetPlanId =
    (typeof details.plan_id === "string" && details.plan_id) ||
    subToUpdate?.plan_id ||
    "";

  if (!targetPlanId) {
    throw new ManualPaymentError("Target plan could not be resolved for this payment.", 400);
  }

  const plan = await db.plans.findUnique({ where: { id: targetPlanId } });
  if (!plan) {
    throw new ManualPaymentError("Target plan no longer exists.", 404);
  }

  const durationDays = details.interval === "yearly" ? 365 : 30;
  const durationMs = durationDays * DAY_MS;

  const isSamePlanActive = Boolean(
    subToUpdate &&
      subToUpdate.status === "active" &&
      subToUpdate.provider !== "trial" &&
      subToUpdate.plan_id === plan.id &&
      new Date(subToUpdate.current_period_end).getTime() > now.getTime()
  );

  const periodBase = isSamePlanActive
    ? new Date(subToUpdate!.current_period_end)
    : now;
  const nextPeriodEnd = new Date(periodBase.getTime() + durationMs);
  const beforeSub = subToUpdate ? { ...subToUpdate } : null;

  let subscription: any;
  if (subToUpdate) {
    subscription = await db.subscriptions.update({
      where: { id: subToUpdate.id },
      data: {
        plan_id: plan.id,
        status: "active",
        provider: "manual",
        current_period_start: isSamePlanActive ? subToUpdate.current_period_start : now,
        current_period_end: nextPeriodEnd,
        cancel_at_period_end: false,
      },
    });
  } else {
    subscription = await db.subscriptions.create({
      data: {
        user_id: payment.user_id,
        plan_id: plan.id,
        status: "active",
        current_period_start: now,
        current_period_end: nextPeriodEnd,
        cancel_at_period_end: false,
        provider: "manual",
        provider_subscription_id: `manual_sub_${Date.now()}`,
      },
    });
  }

  const updatedDetails = {
    ...details,
    plan_id: plan.id,
    plan_slug: plan.slug,
    plan_name: plan.name,
    duration_days: durationDays,
    review_status: "approved",
    reviewed_by: input.adminEmail,
    reviewed_at: now.toISOString(),
    rejection_reason: undefined,
  };

  const updatedPayment = await db.payments.update({
    where: { id: payment.id },
    data: {
      subscription_id: subscription.id,
      status: "succeeded",
      paid_at: now,
      method_details: updatedDetails,
    },
  });

  const user = await db.users.findUnique({
    where: { id: payment.user_id },
    select: { id: true, email: true, name: true, plan: true, plan_id: true },
  });

  await db.users.update({
    where: { id: payment.user_id },
    data: {
      plan: plan.slug,
      plan_id: plan.id,
    },
  });

  await recordAuditLog({
    adminId: input.adminId,
    action: "billing.manual_payment_approved",
    targetType: "payment",
    targetId: payment.id,
    beforeState: {
      paymentStatus: payment.status,
      subscription: beforeSub,
      userPlan: user?.plan,
    },
    afterState: {
      paymentStatus: "succeeded",
      invoiceNumber: payment.invoice_number,
      userId: payment.user_id,
      planSlug: plan.slug,
      planId: plan.id,
      durationDays,
      newPeriodEnd: nextPeriodEnd.toISOString(),
    },
  });

  const formattedEnd = nextPeriodEnd.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  await (db as any).notifications
    ?.create({
      data: {
        user_id: payment.user_id,
        type: `manual_payment_approved_${payment.id}`,
        title: `Payment Approved (${plan.name})`,
        body: `Your payment (${payment.invoice_number}) was approved. Your ${plan.name} plan is active through ${formattedEnd}.`,
        entity_type: "payment",
        entity_id: payment.id,
      },
    })
    .catch(() => null);

  if (user?.email) {
    try {
      const appUrl = (await getAppUrl().catch(() => "http://localhost:3000")).replace(/\/$/, "");
      const billingUrl = `${appUrl}/app/settings/billing`;
      const greeting = user.name?.trim() || "there";
      const amountLine = details.bdt_amount
        ? `${payment.currency} ${Number(payment.amount).toFixed(2)} (BDT ${Number(details.bdt_amount).toLocaleString()})`
        : `${payment.currency} ${Number(payment.amount).toFixed(2)}`;
      const mailRes = await sendSystemMail({
        to: user.email,
        subject: `Payment Receipt — ${plan.name} Plan Activated (${payment.invoice_number})`,
        text: `Hi ${greeting},\n\nYour manual payment has been verified and approved.\n\nInvoice: ${payment.invoice_number}\nPlan: ${plan.name} (${details.interval === "yearly" ? "Yearly - 365 days" : "Monthly - 30 days"})\nAmount: ${amountLine}\nTransaction ID: ${details.transaction_id || payment.provider_payment_id || "N/A"}\nActive Through: ${formattedEnd}\n\nManage billing: ${billingUrl}\n`,
        html: `<p>Hi ${greeting},</p><p>Your manual payment has been verified and approved.</p><ul><li><strong>Invoice:</strong> ${payment.invoice_number}</li><li><strong>Plan:</strong> ${plan.name} (${details.interval === "yearly" ? "Yearly - 365 days" : "Monthly - 30 days"})</li><li><strong>Amount:</strong> ${amountLine}</li><li><strong>Transaction ID:</strong> ${details.transaction_id || payment.provider_payment_id || "N/A"}</li><li><strong>Active Through:</strong> ${formattedEnd}</li></ul><p><a href="${billingUrl}">View Billing &amp; Invoices</a></p>`,
      });
      if (!mailRes.ok) {
        logger.warn({ paymentId: payment.id, err: mailRes.error }, "Receipt email failed; approval preserved");
      }
    } catch (err: any) {
      logger.warn({ paymentId: payment.id, err: err?.message }, "Receipt email threw; approval preserved");
    }
  }

  return {
    success: true,
    alreadyApproved: false,
    userId: payment.user_id,
    payment: updatedPayment,
    subscription,
  };
}

export async function rejectManualPayment(input: {
  paymentId: string;
  reason: string;
  adminId: string;
  adminEmail: string;
}) {
  const cleanReason = (input.reason || "").trim();
  if (cleanReason.length < 3 || cleanReason.length > 300) {
    throw new ManualPaymentError("Please provide a rejection reason (3–300 characters).", 400);
  }

  const payment = await db.payments.findUnique({ where: { id: input.paymentId } });
  if (!payment || payment.provider !== "manual") {
    throw new ManualPaymentError("Manual payment not found.", 404);
  }

  if (payment.status === "failed") {
    return { success: true, alreadyRejected: true, userId: payment.user_id, payment };
  }

  if (payment.status !== "pending") {
    throw new ManualPaymentError("Only pending payments can be rejected.", 409);
  }

  const now = new Date();
  const claim = await db.payments.updateMany({
    where: { id: payment.id, status: "pending" },
    data: { status: "failed" },
  });

  if (claim.count === 0) {
    const reloaded = await db.payments.findUnique({ where: { id: payment.id } });
    if (reloaded?.status === "failed") {
      return { success: true, alreadyRejected: true, userId: reloaded.user_id, payment: reloaded };
    }
    throw new ManualPaymentError("Payment was already processed.", 409);
  }

  const details =
    payment.method_details && typeof payment.method_details === "object"
      ? (payment.method_details as Record<string, any>)
      : {};

  const updatedDetails = {
    ...details,
    review_status: "rejected",
    rejection_reason: cleanReason,
    reviewed_by: input.adminEmail,
    reviewed_at: now.toISOString(),
  };

  const updatedPayment = await db.payments.update({
    where: { id: payment.id },
    data: {
      status: "failed",
      method_details: updatedDetails,
    },
  });

  await recordAuditLog({
    adminId: input.adminId,
    action: "billing.manual_payment_rejected",
    targetType: "payment",
    targetId: payment.id,
    beforeState: { paymentStatus: payment.status },
    afterState: {
      paymentStatus: "failed",
      invoiceNumber: payment.invoice_number,
      userId: payment.user_id,
      reason: cleanReason,
    },
  });

  await (db as any).notifications
    ?.create({
      data: {
        user_id: payment.user_id,
        type: `manual_payment_rejected_${payment.id}`,
        title: `Payment Rejected (${payment.invoice_number})`,
        body: `Your manual payment (${payment.invoice_number}) was rejected. Reason: ${cleanReason}`,
        entity_type: "payment",
        entity_id: payment.id,
      },
    })
    .catch(() => null);

  const user = await db.users.findUnique({
    where: { id: payment.user_id },
    select: { id: true, email: true, name: true },
  });

  if (user?.email) {
    try {
      const appUrl = (await getAppUrl().catch(() => "http://localhost:3000")).replace(/\/$/, "");
      const billingUrl = `${appUrl}/app/settings/billing`;
      const greeting = user.name?.trim() || "there";
      const mailRes = await sendSystemMail({
        to: user.email,
        subject: `Manual Payment Rejected (${payment.invoice_number})`,
        text: `Hi ${greeting},\n\nYour manual payment submission (${payment.invoice_number}) could not be verified and was rejected.\n\nReason: ${cleanReason}\n\nYou can review the payment details and submit a new transfer here:\n${billingUrl}\n`,
        html: `<p>Hi ${greeting},</p><p>Your manual payment submission (<strong>${payment.invoice_number}</strong>) could not be verified and was rejected.</p><p><strong>Reason:</strong> ${cleanReason}</p><p><a href="${billingUrl}">Return to Billing Settings</a></p>`,
      });
      if (!mailRes.ok) {
        logger.warn({ paymentId: payment.id, err: mailRes.error }, "Rejection email failed; rejection preserved");
      }
    } catch (err: any) {
      logger.warn({ paymentId: payment.id, err: err?.message }, "Rejection email threw; rejection preserved");
    }
  }

  return {
    success: true,
    alreadyRejected: false,
    userId: payment.user_id,
    payment: updatedPayment,
  };
}
