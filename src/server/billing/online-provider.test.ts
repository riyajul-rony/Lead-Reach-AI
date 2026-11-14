import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { OnlinePaymentProvider } from "./providers/online-provider";
import * as configModule from "@/server/config";

describe("CRIT-06: OnlinePaymentProvider (Fail-Closed & Manual Billing Mode)", () => {
  const provider = new OnlinePaymentProvider();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createCheckout throws error because online automated checkout is disabled", async () => {
    await expect(
      provider.createCheckout({
        userId: "test-user-id",
        userEmail: "test@example.com",
        planId: "pro-plan-id",
        planSlug: "pro",
        planName: "Pro Plan",
        currency: "USD",
        amount: 49,
        interval: "monthly",
        successUrl: "http://localhost:3000/success",
        cancelUrl: "http://localhost:3000/cancel",
      })
    ).rejects.toThrow("Online automated checkout is currently disabled");
  });

  it("handleWebhook fails closed when secret is not configured", async () => {
    vi.spyOn(configModule, "getConfig").mockResolvedValue(null as any);

    await expect(
      provider.handleWebhook(JSON.stringify({ id: "evt_123" }), {
        "stripe-signature": "some_sig",
      })
    ).rejects.toThrow("Online payment webhook secret is not configured");
  });

  it("handleWebhook fails closed when signature header is missing", async () => {
    vi.spyOn(configModule, "getConfig").mockResolvedValue("test_webhook_secret" as any);

    await expect(
      provider.handleWebhook(JSON.stringify({ id: "evt_123" }), {})
    ).rejects.toThrow("Missing required webhook signature header");
  });

  it("handleWebhook fails closed when signature is invalid", async () => {
    vi.spyOn(configModule, "getConfig").mockResolvedValue("test_webhook_secret" as any);

    await expect(
      provider.handleWebhook(JSON.stringify({ id: "evt_123" }), {
        "stripe-signature": "invalid_hex_signature",
      })
    ).rejects.toThrow("Invalid online webhook signature");
  });

  it("handleWebhook accepts valid HMAC signature when secret is configured", async () => {
    const secret = "test_webhook_secret_key";
    vi.spyOn(configModule, "getConfig").mockResolvedValue(secret as any);

    const payload = JSON.stringify({
      id: "evt_test_success",
      type: "checkout.session.completed",
      data: { object: { id: "cs_123", amount_total: 4900, currency: "usd" } },
    });

    const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    const result = await provider.handleWebhook(payload, {
      "stripe-signature": expectedSig,
    });

    expect(result.handled).toBe(true);
    expect(result.eventId).toBe("evt_test_success");
    expect(result.amount).toBe(49);
  });
});
