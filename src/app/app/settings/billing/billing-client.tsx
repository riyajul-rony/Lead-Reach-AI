"use client";

import React, { useState } from "react";
import { CheckCircle2, Loader2, ArrowRight, X, Sparkles, Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

interface BillingClientProps {
  plans: PlanItem[];
  currentPlanSlug: string;
  activeSubscriptionId?: string;
  isCanceled?: boolean;
  isTrialExpired?: boolean;
  manualConfig: ManualPaymentConfig;
}

export function BillingClient({
  plans,
  currentPlanSlug,
  activeSubscriptionId,
  isCanceled,
  isTrialExpired = false,
  manualConfig,
}: BillingClientProps) {
  const router = useRouter();
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [modalData, setModalData] = useState<{
    invoiceNumber?: string;
    instructionHtml?: string;
    amount?: number;
    planName?: string;
  } | null>(null);

  const handleSelectPlan = async (plan: PlanItem) => {
    if (plan.slug === currentPlanSlug) return;
    if (!manualConfig.isConfigured) {
      setModalData({
        planName: plan.name,
        amount: plan.price_monthly,
      });
      return;
    }

    setLoadingPlanId(plan.id);
    try {
      const res = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          interval: "monthly",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to initialize checkout.");
      }

      if (data.data?.checkoutUrl && !data.data?.instructionHtml) {
        window.location.href = data.data.checkoutUrl;
      } else {
        setModalData({
          invoiceNumber: data.data?.invoiceNumber,
          instructionHtml: data.data?.instructionHtml,
          amount: plan.price_monthly,
          planName: plan.name,
        });
      }
    } catch (err: any) {
      alert(err.message || "Checkout failed");
    } finally {
      setLoadingPlanId(null);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeSubscriptionId) return;
    if (!confirm("Are you sure you want to cancel auto-renewal? You will keep your plan limits until the end of the billing period.")) {
      return;
    }

    setCanceling(true);
    try {
      const res = await fetch("/api/v1/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId: activeSubscriptionId,
        }),
      });

      if (!res.ok) throw new Error("Failed to cancel subscription");
      router.refresh();
    } catch (err: any) {
      alert(err.message || "Cancel failed");
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Active Subscription Cancellation Warning / Trigger */}
      {activeSubscriptionId && currentPlanSlug !== "free" && (
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface border border-border text-xs">
          <div>
            <div className="font-semibold text-fg">Subscription Auto-Renewal</div>
            <div className="text-muted mt-0.5">
              {isCanceled
                ? "Your subscription is scheduled to expire at the end of the current period."
                : "Your subscription automatically renews each month."}
            </div>
          </div>
          {!isCanceled && (
            <Button
              variant="danger"
              size="sm"
              onClick={handleCancelSubscription}
              disabled={canceling}
            >
              {canceling ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Ban size={13} className="mr-1.5" />}
              Cancel Auto-Renew
            </Button>
          )}
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
                ? "Your free trial has ended. Select a paid plan below to immediately restore outreach sending, lead discovery, and social posting."
                : "Choose the plan that fits your business outreach scale."}
            </p>
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
                      ) : isRecommendedPaid ? (
                        <Badge variant="accent" size="sm">Recommended</Badge>
                      ) : null}
                    </div>
                    <div className="my-3 pb-3 border-b border-border">
                      <span className="text-2xl font-bold text-fg">
                        {pFree ? "$0" : `$${p.price_monthly}`}
                      </span>
                      <span className="text-xs text-muted">/month</span>
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
                    {isCurrent ? (
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
                        onClick={() => handleSelectPlan(p)}
                        disabled={isLoading}
                        size="sm"
                        className="w-full"
                      >
                        {isLoading ? (
                          <Loader2 size={13} className="animate-spin" />
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

      {/* Manual Payment Instructions Modal */}
      {modalData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-surface w-full max-w-md rounded-xl p-6 border border-border shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 className="text-base font-semibold text-fg flex items-center gap-2">
                  <Sparkles size={16} className="text-brand" />
                  Upgrade to {modalData.planName}
                </h3>
                <p className="text-xs text-muted">
                  Invoice #{modalData.invoiceNumber || "PENDING"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalData(null)}
                className="text-muted hover:text-fg p-1 h-8 w-8"
              >
                <X size={16} />
              </Button>
            </div>

            <div className="rounded-lg bg-bgSubtle border border-border p-4 text-xs space-y-2 whitespace-pre-line text-fg leading-relaxed">
              {manualConfig.isConfigured && modalData.instructionHtml ? (
                modalData.instructionHtml
              ) : (
                "Manual payment is not set up yet. Please contact the administrator before submitting a payment."
              )}
            </div>

            {manualConfig.isConfigured && (
              <div className="rounded-lg bg-brand/5 border border-brand/20 p-3 text-xs text-brand space-y-1">
                <div className="font-semibold">Next Step:</div>
                <div>
                  Once you complete the transfer, send your Transaction ID and Invoice #{modalData.invoiceNumber} to our support team. Your account will be activated instantly upon verification!
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-border">
              <Button
                onClick={() => {
                  setModalData(null);
                  router.refresh();
                }}
                size="sm"
              >
                Got it
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
