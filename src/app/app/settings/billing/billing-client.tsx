"use client";

import React, { useMemo, useState } from "react";
import { CheckCircle2, Loader2, ArrowRight, Sparkles, Ban, Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import type { ManualPaymentConfig } from "@/server/billing/manual-settings";

interface PlanItem {
  id: string;
  name: string;
  slug: string;
  price_monthly: number;
  price_yearly: number;
  currency: string;
  monthly_leads: number;
  monthly_social_posts: number;
  monthly_outreach_emails: number;
  max_campaigns: number;
  features: string[];
}

export interface RecentPaymentSummary {
  id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  status: string;
  plan_id: string | null;
  plan_name: string | null;
  interval: "monthly" | "yearly";
  method: string | null;
  transaction_id: string | null;
  sender_number: string | null;
  user_note: string | null;
  bdt_amount: number | null;
  submitted_at: string | null;
  rejection_reason: string | null;
}

interface BillingClientProps {
  plans: PlanItem[];
  currentPlanSlug: string;
  activeSubscriptionId?: string;
  isCanceled?: boolean;
  isTrialExpired?: boolean;
  manualConfig: ManualPaymentConfig;
  recentPayments?: RecentPaymentSummary[];
  renewablePlanId?: string | null;
  isPaidExpired?: boolean;
}

export function BillingClient({
  plans,
  currentPlanSlug,
  activeSubscriptionId,
  isCanceled,
  isTrialExpired = false,
  manualConfig,
  recentPayments = [],
  renewablePlanId = null,
  isPaidExpired = false,
}: BillingClientProps) {
  const router = useRouter();
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const availableMethods = useMemo(() => {
    const list: Array<{ id: "bkash" | "nagad" | "bank"; label: string }> = [];
    if (manualConfig.bkashNumber) list.push({ id: "bkash", label: "bKash" });
    if (manualConfig.nagadNumber) list.push({ id: "nagad", label: "Nagad" });
    if (manualConfig.bankName && manualConfig.bankAccountNumber) {
      list.push({ id: "bank", label: "Bank Transfer" });
    }
    return list;
  }, [manualConfig]);

  const [modalData, setModalData] = useState<{
    paymentId: string;
    invoiceNumber: string;
    amount: number;
    currency: string;
    bdtAmount: number | null;
    planName: string;
    interval: "monthly" | "yearly";
    alreadySubmitted: boolean;
    submittedMethod?: string | null;
    submittedTrxId?: string | null;
    submittedSender?: string | null;
  } | null>(null);

  const [method, setMethod] = useState<"bkash" | "nagad" | "bank">(
    availableMethods[0]?.id || "bkash"
  );
  const [transactionId, setTransactionId] = useState("");
  const [senderNumber, setSenderNumber] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  const pendingByPlanId = useMemo(() => {
    const map = new Map<string, RecentPaymentSummary>();
    for (const p of recentPayments) {
      if (p.status === "pending" && p.plan_id && !map.has(p.plan_id)) {
        map.set(p.plan_id, p);
      }
    }
    return map;
  }, [recentPayments]);

  const latestRejected = useMemo(
    () => recentPayments.find((p) => p.status === "failed" && p.rejection_reason),
    [recentPayments]
  );

  const renewablePlan = useMemo(
    () => (renewablePlanId ? plans.find((p) => p.id === renewablePlanId) || null : null),
    [plans, renewablePlanId]
  );

  const startManualCheckout = async (plan: PlanItem) => {
    setBannerError(null);
    if (!manualConfig.isConfigured) {
      setBannerError("Manual payment is not set up yet. Please contact the administrator.");
      return;
    }

    const planAmount = interval === "yearly" ? plan.price_yearly : plan.price_monthly;
    setLoadingPlanId(plan.id);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      const res = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          interval,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to initialize checkout.");
      }

      if (data.data?.checkoutUrl && !data.data?.instructionHtml) {
        window.location.href = data.data.checkoutUrl;
        return;
      }

      const existingPending = pendingByPlanId.get(plan.id);
      const alreadySubmitted = Boolean(data.data?.alreadySubmitted);
      setMethod(availableMethods[0]?.id || "bkash");
      setTransactionId("");
      setSenderNumber("");
      setNote("");
      setModalData({
        paymentId: data.data?.sessionId,
        invoiceNumber: data.data?.invoiceNumber || "PENDING",
        amount: planAmount,
        currency: plan.currency || "USD",
        bdtAmount:
          typeof data.data?.bdtAmount === "number"
            ? data.data.bdtAmount
            : manualConfig.usdToBdtRate
            ? Math.round(planAmount * manualConfig.usdToBdtRate)
            : null,
        planName: plan.name,
        interval,
        alreadySubmitted,
        submittedMethod: existingPending?.method || null,
        submittedTrxId: existingPending?.transaction_id || null,
        submittedSender: existingPending?.sender_number || null,
      });
    } catch (err: any) {
      setBannerError(err.message || "Checkout failed.");
    } finally {
      setLoadingPlanId(null);
    }
  };

  const handleSubmitPaymentDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalData) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/v1/billing/manual/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: modalData.paymentId,
          method,
          transactionId: transactionId.trim(),
          senderNumber: senderNumber.trim(),
          note: note.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit payment details.");
      }

      setModalData({
        ...modalData,
        alreadySubmitted: true,
        submittedMethod: data.data?.method || method,
        submittedTrxId: data.data?.transactionId || transactionId.trim(),
        submittedSender: data.data?.senderNumber || senderNumber.trim(),
      });
      setSubmitSuccess("Payment details submitted and waiting for admin review.");
      router.refresh();
    } catch (err: any) {
      setSubmitError(err.message || "Failed to submit payment details.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeSubscriptionId) return;
    setCanceling(true);
    setBannerError(null);
    try {
      const res = await fetch("/api/v1/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId: activeSubscriptionId,
        }),
      });

      if (!res.ok) throw new Error("Failed to cancel subscription");
      setCancelDialogOpen(false);
      router.refresh();
    } catch (err: any) {
      setBannerError(err.message || "Cancel failed");
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Active / Expired Paid Plan Renewal Bar */}
      {renewablePlan && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-surface border border-border text-xs">
          <div>
            <div className="font-semibold text-fg">
              {isPaidExpired
                ? `Your ${renewablePlan.name} plan has expired`
                : `Renew ${renewablePlan.name} Plan`}
            </div>
            <div className="text-muted mt-0.5">
              {isPaidExpired
                ? "Renew now to immediately reactivate your paid plan and lift account restrictions."
                : "Renew early via manual payment to extend your active period without interruption."}
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => startManualCheckout(renewablePlan)}
            disabled={loadingPlanId === renewablePlan.id || !manualConfig.isConfigured}
          >
            {loadingPlanId === renewablePlan.id ? (
              <Loader2 size={13} className="animate-spin mr-1.5" />
            ) : null}
            Renew {renewablePlan.name}
          </Button>
        </div>
      )}

      {/* Active Subscription Cancellation Warning / Trigger */}
      {activeSubscriptionId && currentPlanSlug !== "free" && (
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface border border-border text-xs">
          <div>
            <div className="font-semibold text-fg">Subscription Auto-Renewal</div>
            <div className="text-muted mt-0.5">
              {isCanceled
                ? "Your subscription is scheduled to expire at the end of the current period."
                : "Your subscription is active for the current billing period."}
            </div>
          </div>
          {!isCanceled && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setCancelDialogOpen(true)}
              disabled={canceling}
            >
              {canceling ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Ban size={13} className="mr-1.5" />}
              Cancel Auto-Renew
            </Button>
          )}
        </div>
      )}

      {latestRejected && (
        <div className="rounded-lg border border-danger/30 bg-dangerBg px-4 py-3 text-xs text-fg space-y-1">
          <div className="font-semibold text-danger">
            Latest Manual Payment Rejected ({latestRejected.invoice_number})
          </div>
          <div>
            Reason: <span className="font-medium">{latestRejected.rejection_reason}</span>
          </div>
        </div>
      )}

      {bannerError && (
        <div className="rounded-lg border border-danger/30 bg-dangerBg px-4 py-3 text-xs text-danger">
          {bannerError}
        </div>
      )}

      {/* Available Plans Comparison Cards */}
      <div id="upgrade-plans" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-fg">
              {isTrialExpired ? "Upgrade to Continue Using Lead Reach AI" : "Compare Plans & Upgrade"}
            </h3>
            <p className="text-xs text-muted">
              {isTrialExpired
                ? "Your free trial has ended. Select a paid plan below to restore outreach sending, lead discovery, and social posting."
                : "Choose a plan and billing interval. Accounts activate as soon as your manual payment is verified."}
            </p>
          </div>

          {/* Monthly / Yearly Toggle */}
          <div className="inline-flex rounded-lg border border-border bg-surface p-1 self-start">
            <button
              type="button"
              onClick={() => setInterval("monthly")}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                interval === "monthly"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted hover:text-fg"
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setInterval("yearly")}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                interval === "yearly"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted hover:text-fg"
              }`}
            >
              Yearly (365d)
            </button>
          </div>
        </div>

        {!manualConfig.isConfigured && (
          <div className="rounded-lg border border-warning/30 bg-warningBg px-4 py-3 text-xs text-fg">
            Manual payment is not set up yet. Please contact the administrator before submitting an upgrade payment.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const isCurrent = p.slug === currentPlanSlug;
            const pFree = p.slug === "free" || Number(p.price_monthly) === 0;
            const isRecommendedPaid = isTrialExpired && p.slug === "pro";
            const isLoading = loadingPlanId === p.id;
            const displayPrice = interval === "yearly" ? p.price_yearly : p.price_monthly;
            const displayBdt =
              !pFree && manualConfig.usdToBdtRate && displayPrice > 0
                ? Math.round(displayPrice * manualConfig.usdToBdtRate)
                : null;
            const openPending = pendingByPlanId.get(p.id);
            const waitingReview = Boolean(openPending?.submitted_at || openPending?.transaction_id);

            return (
              <Card
                key={p.id}
                className={`flex flex-col justify-between transition-colors duration-150 ${
                  isRecommendedPaid
                    ? "border-[var(--brand-emerald)] shadow-md ring-2 ring-[var(--brand-emerald)]/40"
                    : isCurrent && !isTrialExpired
                    ? "border-[var(--brand-emerald)] shadow-sm ring-1 ring-[var(--brand-emerald)]/30"
                    : isCurrent && isTrialExpired
                    ? "border-danger/40 opacity-85"
                    : "hover:border-borderStrong"
                }`}
              >
                <CardContent className="p-5 flex flex-col justify-between h-full space-y-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-base text-fg">{p.name}</h4>
                      {isCurrent && isTrialExpired ? (
                        <Badge variant="danger" size="sm">Ended</Badge>
                      ) : isCurrent ? (
                        <Badge variant="success" size="sm" dot>Active</Badge>
                      ) : waitingReview ? (
                        <Badge variant="warning" size="sm">In Review</Badge>
                      ) : isRecommendedPaid ? (
                        <Badge variant="accent" size="sm">Recommended</Badge>
                      ) : null}
                    </div>
                    <div className="my-3 pb-3 border-b border-border">
                      <span className="text-2xl font-bold text-fg">
                        {pFree ? "$0" : `$${displayPrice}`}
                      </span>
                      <span className="text-xs text-muted">
                        /{interval === "yearly" ? "year" : "month"}
                      </span>
                      {displayBdt !== null && (
                        <div className="text-xs text-muted mt-0.5 font-mono">
                          ≈ BDT {displayBdt.toLocaleString()}
                        </div>
                      )}
                    </div>

                    <ul className="text-xs space-y-2 text-muted my-3">
                      <li className="flex items-center gap-1.5">
                        <CheckCircle2 size={13} className="text-[var(--badge-success-text)] shrink-0" />
                        <span>{Number(p.monthly_leads) >= 999999 ? "Unlimited" : Number(p.monthly_leads).toLocaleString()} monthly leads</span>
                      </li>
                      <li className="flex items-center gap-1.5">
                        <CheckCircle2 size={13} className="text-[var(--badge-success-text)] shrink-0" />
                        <span>{Number(p.monthly_social_posts) >= 999999 ? "Unlimited" : Number(p.monthly_social_posts).toLocaleString()} social posts</span>
                      </li>
                      <li className="flex items-center gap-1.5">
                        <CheckCircle2 size={13} className="text-[var(--badge-success-text)] shrink-0" />
                        <span>{Number(p.monthly_outreach_emails) >= 999999 ? "Unlimited" : Number(p.monthly_outreach_emails).toLocaleString()} outreach emails</span>
                      </li>
                      <li className="flex items-center gap-1.5">
                        <CheckCircle2 size={13} className="text-[var(--badge-success-text)] shrink-0" />
                        <span>{p.max_campaigns} campaigns</span>
                      </li>
                    </ul>
                  </div>

                  <div className="pt-3 border-t border-border">
                    {isCurrent && !pFree ? (
                      <Button
                        variant="secondary"
                        onClick={() => startManualCheckout(p)}
                        disabled={isLoading || !manualConfig.isConfigured}
                        size="sm"
                        className="w-full"
                      >
                        {isLoading ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : waitingReview ? (
                          <>
                            <Clock size={13} className="mr-1.5" /> View Renewal Status
                          </>
                        ) : (
                          <>
                            Renew {p.name} <ArrowRight size={13} className="ml-1" />
                          </>
                        )}
                      </Button>
                    ) : isCurrent ? (
                      <span
                        className={`text-xs font-semibold block text-center py-1.5 ${
                          isTrialExpired ? "text-danger" : "text-[var(--badge-success-text)]"
                        }`}
                      >
                        {isTrialExpired ? "Free Trial Ended" : "Current Plan"}
                      </span>
                    ) : pFree ? (
                      <span className="text-xs text-muted block text-center py-1.5">
                        14-day introductory trial only
                      </span>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => startManualCheckout(p)}
                        disabled={isLoading || !manualConfig.isConfigured}
                        size="sm"
                        className="w-full"
                      >
                        {isLoading ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : waitingReview ? (
                          <>
                            <Clock size={13} className="mr-1.5" /> Waiting for Review
                          </>
                        ) : (
                          <>
                            Upgrade to {p.name} <ArrowRight size={13} className="ml-1" />
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Cancel Auto-Renew Confirmation Dialog */}
      <Dialog
        open={cancelDialogOpen}
        onClose={() => setCancelDialogOpen(false)}
        title="Cancel Subscription Auto-Renewal?"
        description="You will keep your paid plan quotas until the end of your current billing period."
        confirmLabel="Confirm Cancellation"
        confirmVariant="danger"
        loading={canceling}
        onConfirm={handleCancelSubscription}
      />

      {/* Manual Payment Instructions & Submission Dialog */}
      <Dialog
        open={Boolean(modalData)}
        onClose={() => setModalData(null)}
        title={modalData ? `${modalData.planName} (${modalData.interval === "yearly" ? "Yearly" : "Monthly"})` : ""}
        description={modalData ? `Invoice #${modalData.invoiceNumber}` : ""}
      >
        {modalData && (
          <div className="space-y-4">
            {/* Amount Summary */}
            <div className="rounded-lg border border-border bg-bgSubtle p-3 flex items-center justify-between text-xs">
              <span className="text-muted font-medium">Amount Due</span>
              <div className="text-right font-mono font-bold text-fg">
                <div>
                  {modalData.currency} {modalData.amount.toFixed(2)}
                </div>
                {modalData.bdtAmount !== null && (
                  <div className="text-[11px] text-brand">
                    BDT {modalData.bdtAmount.toLocaleString()}
                    {manualConfig.usdToBdtRate ? ` (@ ${manualConfig.usdToBdtRate} BDT/USD)` : ""}
                  </div>
                )}
              </div>
            </div>

            {!manualConfig.isConfigured ? (
              <div className="rounded-lg border border-warning/30 bg-warningBg p-3 text-xs text-fg">
                Manual payment is not set up yet. Please contact the administrator.
              </div>
            ) : (
              <>
                {/* Configured Payment Accounts */}
                <div className="rounded-lg border border-border bg-surface p-3.5 text-xs space-y-1.5">
                  <div className="font-semibold text-fg flex items-center gap-1.5">
                    <Sparkles size={13} className="text-brand" />
                    Send Payment To:
                  </div>
                  {manualConfig.bkashNumber && (
                    <div>
                      <span className="text-muted">bKash:</span>{" "}
                      <span className="font-mono font-semibold text-fg">{manualConfig.bkashNumber}</span>
                    </div>
                  )}
                  {manualConfig.nagadNumber && (
                    <div>
                      <span className="text-muted">Nagad:</span>{" "}
                      <span className="font-mono font-semibold text-fg">{manualConfig.nagadNumber}</span>
                    </div>
                  )}
                  {manualConfig.bankName && manualConfig.bankAccountNumber && (
                    <div>
                      <span className="text-muted">Bank:</span>{" "}
                      <span className="font-medium text-fg">{manualConfig.bankName}</span>
                      {manualConfig.bankAccountName ? ` (${manualConfig.bankAccountName})` : ""} —{" "}
                      <span className="font-mono font-semibold text-fg">{manualConfig.bankAccountNumber}</span>
                    </div>
                  )}
                  {manualConfig.note && (
                    <div className="pt-1 text-muted whitespace-pre-line">{manualConfig.note}</div>
                  )}
                </div>

                {modalData.alreadySubmitted ? (
                  <div className="rounded-lg border border-warning/30 bg-warningBg p-3.5 text-xs space-y-1.5">
                    <div className="font-semibold text-fg flex items-center gap-1.5">
                      <Clock size={14} className="text-warning" />
                      Waiting for Admin Review
                    </div>
                    {submitSuccess && <div className="text-emerald-600 dark:text-emerald-400">{submitSuccess}</div>}
                    <div className="text-muted">
                      Method: <span className="text-fg capitalize font-medium">{modalData.submittedMethod}</span>
                    </div>
                    <div className="text-muted">
                      Transaction ID: <span className="text-fg font-mono font-medium">{modalData.submittedTrxId}</span>
                    </div>
                    <div className="text-muted">
                      Sender Number: <span className="text-fg font-mono font-medium">{modalData.submittedSender}</span>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleSubmitPaymentDetails} className="space-y-3 text-xs">
                    {submitError && (
                      <div className="rounded-lg border border-danger/30 bg-dangerBg px-3 py-2 text-danger">
                        {submitError}
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1">
                        Payment Method
                      </label>
                      <select
                        value={method}
                        onChange={(e) => setMethod(e.target.value as "bkash" | "nagad" | "bank")}
                        className="w-full h-9 rounded-[6px] border border-border-input bg-surface px-3 text-xs text-text focus:border-focus-ring focus:outline-none"
                      >
                        {availableMethods.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <Input
                      label="Transaction ID"
                      value={transactionId}
                      onChange={(e) => setTransactionId(e.target.value)}
                      placeholder="e.g. TXN9A7B3C"
                      minLength={4}
                      maxLength={80}
                      required
                    />

                    <Input
                      label="Sender Number / Account"
                      value={senderNumber}
                      onChange={(e) => setSenderNumber(e.target.value)}
                      placeholder="Number or account used to send"
                      minLength={4}
                      maxLength={40}
                      required
                    />

                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1">
                        Optional Note
                      </label>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={2}
                        maxLength={500}
                        placeholder="Any extra reference or transfer details"
                        className="w-full rounded-[6px] border border-border-input bg-surface px-3 py-2 text-xs text-text placeholder:text-text-subtle focus:border-focus-ring focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <Button type="button" variant="secondary" size="sm" onClick={() => setModalData(null)}>
                        Close
                      </Button>
                      <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                        {submitting && <Loader2 size={13} className="animate-spin mr-1.5" />}
                        Submit for Review
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
