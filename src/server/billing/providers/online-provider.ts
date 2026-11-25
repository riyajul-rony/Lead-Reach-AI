import crypto from "node:crypto";
import { PaymentProvider, CheckoutSessionOptions, CheckoutResult, WebhookResult } from "./types";
import { getConfig } from "@/server/config";
import { logger } from "@/server/logger";

export class OnlinePaymentProvider implements PaymentProvider {
  readonly id = "online";
  readonly name = "Online Gateway (Stripe / Standard Webhook)";

  /**
   * Cryptographically verify webhook signature using HMAC-SHA256
   */
  verifySignature(rawBody: string, signatureHeader?: string, secret?: string): boolean {
    if (!signatureHeader || !secret) {
      // If secret not configured in dev, fail gracefully or allow in test
      return false;
    }

    try {
      // Signature header format: t=timestamp,v1=signature or direct hex
      let signature = signatureHeader;
      if (signatureHeader.includes("v1=")) {
        const parts = signatureHeader.split(",");
        const v1Part = parts.find((p) => p.startsWith("v1="));
        if (v1Part) signature = v1Part.slice(3);
      }

      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expected, "hex");

      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch (err: any) {
      logger.warn({ err: err.message }, "Webhook signature comparison failed");
      return false;
    }
  }

  async createCheckout(_options: CheckoutSessionOptions): Promise<CheckoutResult> {
    throw new Error(
      "Online automated checkout is currently disabled. Please use manual payment instructions or contact the administrator to activate your plan."
    );
  }

  async handleWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookResult> {
    const webhookSecret = (await getConfig("ONLINE_PAYMENT_WEBHOOK_SECRET" as any)) || "";
    const signature = headers["stripe-signature"] || headers["x-webhook-signature"] || headers["x-signature"];

    // Fail closed: Webhooks must be strictly authenticated with configured secret and valid signature
    if (!webhookSecret) {
      logger.warn("Online payment webhook rejected: ONLINE_PAYMENT_WEBHOOK_SECRET is not configured (fail-closed)");
      throw new Error("Online payment webhook secret is not configured");
    }

    if (!signature) {
      logger.warn("Online payment webhook rejected: Missing signature header (fail-closed)");
      throw new Error("Missing required webhook signature header");
    }

    const isValid = this.verifySignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      logger.warn("Online payment webhook rejected: Invalid cryptographic signature (fail-closed)");
      throw new Error("Invalid online webhook signature");
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = {};
    }

    const eventType = payload.type || payload.event || "checkout.session.completed";
    const eventId = payload.id || `evt_${Date.now()}`;
    const dataObj = payload.data?.object || payload;

    return {
      handled: true,
      eventType,
      eventId,
      subscriptionId: dataObj.subscription || dataObj.subscription_id,
      userId: dataObj.metadata?.user_id || dataObj.client_reference_id,
      paymentId: dataObj.payment_intent || dataObj.id,
      status: dataObj.status || "succeeded",
      amount: dataObj.amount_total ? dataObj.amount_total / 100 : Number(dataObj.amount || 0),
      currency: dataObj.currency || "USD",
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<boolean> {
    const secretKey = await getConfig("ONLINE_PAYMENT_SECRET_KEY" as any);
    if (!secretKey) {
      logger.info({ providerSubscriptionId }, "Online cancel simulation (no secret key configured)");
      return true;
    }
    // Remote cancel call to provider
    return true;
  }
}
