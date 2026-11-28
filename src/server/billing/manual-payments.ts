import { z } from "zod";
import { db } from "@/server/db";
import { getManualPaymentConfig, computeBdtAmount } from "@/server/billing/manual-settings";

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
