import { db } from "@/server/db";
import { PaymentProvider, CheckoutSessionOptions, CheckoutResult, WebhookResult } from "./types";
import {
  computeBdtAmount,
  formatManualInstructionsText,
  getManualPaymentConfig,
} from "@/server/billing/manual-settings";

export class ManualPaymentProvider implements PaymentProvider {
  readonly id = "manual";
  readonly name = "Manual Payment (bKash / Nagad / Bank)";

  async createCheckout(options: CheckoutSessionOptions): Promise<CheckoutResult> {
    const now = new Date();
    const config = await getManualPaymentConfig();
    const bdtAmount = computeBdtAmount(options.amount, config.usdToBdtRate);

    // Link existing active/past_due paid subscription if present (never activate a paid sub before admin approval)
    const existingSub = await db.subscriptions.findFirst({
      where: {
        user_id: options.userId,
        status: { in: ["active", "past_due"] },
        provider: { not: "trial" },
      },
      orderBy: { created_at: "desc" },
    });

    // Enforce at most one open pending manual payment per (userId, planId)
    const pendingPayments = await db.payments.findMany({
      where: {
        user_id: options.userId,
        status: "pending",
        provider: "manual",
      },
      orderBy: { created_at: "desc" },
      take: 25,
    });

    const existingPending = pendingPayments.find((p: any) => {
      const details = p.method_details && typeof p.method_details === "object"
        ? (p.method_details as Record<string, any>)
        : {};
      return details.plan_id === options.planId;
    });

    if (existingPending) {
      const existingDetails =
        existingPending.method_details && typeof existingPending.method_details === "object"
          ? (existingPending.method_details as Record<string, any>)
          : {};
      const alreadySubmitted = Boolean(existingDetails.submitted_at || existingDetails.transaction_id);

      if (!alreadySubmitted) {
        await db.payments.update({
          where: { id: existingPending.id },
          data: {
            amount: options.amount,
            currency: options.currency || "USD",
            subscription_id: existingSub?.id ?? existingPending.subscription_id ?? null,
            method_details: {
              ...existingDetails,
              plan_id: options.planId,
              plan_slug: options.planSlug,
              plan_name: options.planName,
              interval: options.interval,
              bdt_amount: bdtAmount,
              usd_to_bdt_rate: config.usdToBdtRate,
              note: "Pending manual payment submission",
            },
          },
        });
      }

      const instructionHtml = config.isConfigured
        ? formatManualInstructionsText(
            config,
            alreadySubmitted ? Number(existingPending.amount) : options.amount,
            existingPending.currency || options.currency || "USD",
            existingPending.invoice_number
          )
        : "";

      return {
        sessionId: existingPending.id,
        provider: "manual",
        invoiceNumber: existingPending.invoice_number,
        instructionHtml,
        configured: config.isConfigured,
        alreadySubmitted,
        existingStatus: alreadySubmitted ? "waiting_review" : "pending_submission",
        bdtAmount: alreadySubmitted ? (existingDetails.bdt_amount ?? bdtAmount) : bdtAmount,
        usdToBdtRate: config.usdToBdtRate,
      };
    }

    // 2. Generate unique invoice number: INV-YYYYMM-XXXX
    const yyyymm = now.toISOString().slice(0, 7).replace("-", "");
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const invoiceNumber = `INV-${yyyymm}-${randomSuffix}`;

    // 3. Create pending payment record
    const payment = await db.payments.create({
      data: {
        user_id: options.userId,
        subscription_id: existingSub?.id ?? null,
        amount: options.amount,
        currency: options.currency || "USD",
        status: "pending",
        provider: "manual",
        provider_payment_id: `manual_pay_${Date.now()}`,
        invoice_number: invoiceNumber,
        method_details: {
          plan_id: options.planId,
          plan_slug: options.planSlug,
          plan_name: options.planName,
          interval: options.interval,
          bdt_amount: bdtAmount,
          usd_to_bdt_rate: config.usdToBdtRate,
          note: "Pending manual payment submission",
        },
      },
    });

    const instructionHtml = config.isConfigured
      ? formatManualInstructionsText(config, options.amount, options.currency || "USD", invoiceNumber)
      : "";

    return {
      sessionId: payment.id,
      provider: "manual",
      invoiceNumber,
      instructionHtml,
      configured: config.isConfigured,
      alreadySubmitted: false,
      existingStatus: "pending_submission",
      bdtAmount,
      usdToBdtRate: config.usdToBdtRate,
    };
  }

  async handleWebhook(_rawBody: string, _headers: Record<string, string>): Promise<WebhookResult> {
    return {
      handled: false,
      eventType: "manual.disabled",
      eventId: `manual_disabled_${Date.now()}`,
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<boolean> {
    const sub = await db.subscriptions.findFirst({
      where: { provider_subscription_id: providerSubscriptionId },
    });
    if (sub) {
      await db.subscriptions.update({
        where: { id: sub.id },
        data: { cancel_at_period_end: true },
      });
    }
    return true;
  }
}
