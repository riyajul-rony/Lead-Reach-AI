import Link from "next/link";
import {
  Sparkles,
  CheckCircle2,
  Zap,
  Globe,
  Share2,
  Mail,
  Receipt,
  AlertCircle,
  Calendar,
} from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { getUserUsageAndLimits } from "@/server/billing/limits";
import { getTrialStatus } from "@/server/billing/trial";
import { getManualPaymentConfig } from "@/server/billing/manual-settings";
import { BillingClient } from "./billing-client";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = {
  title: "Plan & Resource Limits — Lead Reach AI",
  description: "View your subscription tier, resource quotas, and current month usage.",
};

export default async function BillingSettingsPage() {
  const user = await requireUser();
  const [limitsAndUsage, trialStatus, manualConfig] = await Promise.all([
    getUserUsageAndLimits(user.id),
    getTrialStatus(user.id).catch(() => null),
    getManualPaymentConfig().catch(() => ({
      bkashNumber: "",
      nagadNumber: "",
      bankName: "",
      bankAccountName: "",
      bankAccountNumber: "",
      note: "",
      usdToBdtRate: null,
      isConfigured: false,
    })),
  ]);

  // Fetch active subscription
  const activeSubscription = await db.subscriptions.findFirst({
    where: {
      user_id: user.id,
      status: { in: ["active", "trialing", "past_due"] },
    },
  }).catch(() => null);

  // Fetch recent payments / invoices for this user
  const userPayments = await db.payments.findMany({
    where: { user_id: user.id },
    orderBy: { created_at: "desc" },
    take: 10,
  }).catch(() => []);

  // Fetch all active public plans for tier comparison
  const allPlans = await db.plans.findMany({
    where: { is_active: true },
    orderBy: { monthly_price: "asc" },
  }).catch(() => []);

  const { plan, limits, overrides } = limitsAndUsage;
  const planMonthlyPrice = Number((plan as any).monthly_price ?? plan.price_monthly ?? 0);
  const planYearlyPrice = Number((plan as any).yearly_price ?? plan.price_yearly ?? 0);
  const isFree = plan.slug === "free" || planMonthlyPrice === 0;

  const plansForClient = allPlans.map((p: any) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    price_monthly: Number(p.monthly_price ?? p.price_monthly ?? 0),
    price_yearly: Number(p.yearly_price ?? p.price_yearly ?? 0),
    currency: p.currency,
    monthly_leads: Number(p.monthly_leads),
    monthly_social_posts: Number(p.monthly_social_posts),
    monthly_outreach_emails: Number(p.monthly_outreach_emails),
    max_campaigns: Number(p.max_campaigns),
    features: Array.isArray(p.features) ? p.features : [],
  }));

  const periodEnd = activeSubscription?.current_period_end
    ? new Date(activeSubscription.current_period_end)
    : null;

  const recentPaymentsForClient = userPayments.map((p: any) => {
    const details =
      p.method_details && typeof p.method_details === "object"
        ? (p.method_details as Record<string, any>)
        : {};
    return {
      id: p.id,
      invoice_number: p.invoice_number,
      amount: Number(p.amount || 0),
      currency: p.currency || "USD",
      status: p.status,
      plan_id: typeof details.plan_id === "string" ? details.plan_id : null,
      plan_name: typeof details.plan_name === "string" ? details.plan_name : null,
      interval: details.interval === "yearly" ? ("yearly" as const) : ("monthly" as const),
      method: typeof details.method === "string" ? details.method : null,
      transaction_id: typeof details.transaction_id === "string" ? details.transaction_id : null,
      sender_number: typeof details.sender_number === "string" ? details.sender_number : null,
      user_note: typeof details.user_note === "string" ? details.user_note : null,
      bdt_amount: typeof details.bdt_amount === "number" ? details.bdt_amount : null,
      submitted_at: typeof details.submitted_at === "string" ? details.submitted_at : null,
      rejection_reason: typeof details.rejection_reason === "string" ? details.rejection_reason : null,
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <PageHeader
        title="Plan & Quotas"
        description="Review your subscription features, monthly resource quotas, and platform utilization."
      />

      <SettingsNav />

      {trialStatus?.status === "expired" && (
        <div
          role="alert"
          className="rounded-xl border border-danger/40 bg-dangerBg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-bold text-fg">
              <AlertCircle size={17} className="text-danger shrink-0" />
              Your 14-day free trial has ended
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Choose any paid plan below to unlock campaign launches, lead searches, enrichment, and social publishing immediately.
            </p>
          </div>
          <a
            href="#upgrade-plans"
            className="btn btn-primary text-xs px-4 py-2 shrink-0 self-start sm:self-center"
          >
            Choose a Paid Plan
          </a>
        </div>
      )}

      {/* Current Active Plan Overview */}
      <Card>
        <CardContent className="p-6 sm:p-7 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-border">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="accent" size="sm">
                  <Sparkles size={11} className="mr-1" /> Current Active Tier
                </Badge>
                {trialStatus?.status === "expired" ? (
                  <Badge variant="danger" size="sm">
                    Trial Ended
                  </Badge>
                ) : activeSubscription ? (
                  <Badge variant={activeSubscription.status === "active" ? "success" : "warning"} size="sm">
                    {activeSubscription.status === "trialing" && trialStatus?.status === "active"
                      ? `Free Trial · ${trialStatus.daysLeft}d left`
                      : activeSubscription.status}
                  </Badge>
                ) : null}
              </div>
              <h2 className="text-2xl font-bold text-fg">{plan.name} Plan</h2>
              <p className="text-xs text-muted">
                {plan.description || "Active automation and outreach suite subscription."}
              </p>
              {periodEnd && (
                <div className="flex items-center gap-1.5 text-xs text-muted pt-1">
                  <Calendar size={13} className="text-brand" />
                  <span>
                    {activeSubscription?.cancel_at_period_end ? "Expires on: " : "Next renewal: "}
                    <strong className="text-fg">{periodEnd.toLocaleDateString()}</strong>
                  </span>
                </div>
              )}
            </div>

            <div className="sm:text-right">
              <div className="text-3xl font-bold text-fg">
                {isFree ? "$0" : `$${planMonthlyPrice}`}
                <span className="text-xs text-muted font-normal"> / month</span>
              </div>
              {!isFree && (
                <div className="text-xs text-muted font-medium mt-0.5">
                  ${planYearlyPrice}/yr billed annually ({plan.currency})
                </div>
              )}
            </div>
          </div>

          {/* Live Quotas Grid */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-muted flex items-center gap-1.5">
              <Zap size={13} className="text-amber-500" /> Monthly Quotas &amp; Live Usage
            </h3>

            <div className="grid gap-4 sm:grid-cols-3">
              {/* Leads */}
              <div className="rounded-lg border border-border bg-bgSubtle p-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg flex items-center gap-1.5">
                    <Globe size={13} className="text-brand" /> Leads Scraped
                  </span>
                  {overrides?.monthly_leads != null && (
                    <Badge variant="neutral" size="sm">Custom</Badge>
                  )}
                </div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted">Used:</span>
                  <span className="font-mono font-semibold text-fg">
                    {limits.monthly_leads.current} / {limits.monthly_leads.limit >= 999999 ? "Unlimited" : limits.monthly_leads.limit.toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-border h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-brand h-full rounded-full transition-all"
                    style={{
                      width: `${limits.monthly_leads.percentage}%`,
                    }}
                  />
                </div>
              </div>

              {/* Social Posts */}
              <div className="rounded-lg border border-border bg-bgSubtle p-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg flex items-center gap-1.5">
                    <Share2 size={13} className="text-blue-500" /> Social Posts
                  </span>
                  {overrides?.monthly_social_posts != null && (
                    <Badge variant="neutral" size="sm">Custom</Badge>
                  )}
                </div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted">Used:</span>
                  <span className="font-mono font-semibold text-fg">
                    {limits.monthly_social_posts.current} / {limits.monthly_social_posts.limit >= 999999 ? "Unlimited" : limits.monthly_social_posts.limit.toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-border h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full transition-all"
                    style={{
                      width: `${limits.monthly_social_posts.percentage}%`,
                    }}
                  />
                </div>
              </div>

              {/* Outreach Emails */}
              <div className="rounded-lg border border-border bg-bgSubtle p-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg flex items-center gap-1.5">
                    <Mail size={13} className="text-amber-500" /> Outreach Emails
                  </span>
                  {overrides?.monthly_outreach_emails != null && (
                    <Badge variant="neutral" size="sm">Custom</Badge>
                  )}
                </div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted">Used:</span>
                  <span className="font-mono font-semibold text-fg">
                    {limits.monthly_outreach_emails.current} / {limits.monthly_outreach_emails.limit >= 999999 ? "Unlimited" : limits.monthly_outreach_emails.limit.toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-border h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-amber-500 h-full rounded-full transition-all"
                    style={{
                      width: `${limits.monthly_outreach_emails.percentage}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Hard Caps */}
            <div className="grid gap-3 sm:grid-cols-3 pt-2 text-xs">
              <div className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border">
                <span className="text-muted">Connected Socials:</span>
                <span className="font-mono font-medium text-fg">
                  {limits.max_social_accounts.current} / {limits.max_social_accounts.limit}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border">
                <span className="text-muted">Email Inboxes:</span>
                <span className="font-mono font-medium text-fg">
                  {limits.max_email_accounts.current} / {limits.max_email_accounts.limit}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border">
                <span className="text-muted">Active Campaigns:</span>
                <span className="font-mono font-medium text-fg">
                  {limits.max_campaigns.current} / {limits.max_campaigns.limit}
                </span>
              </div>
            </div>
          </div>

          {/* Features included */}
          {plan.features && plan.features.length > 0 && (
            <div className="pt-4 border-t border-border space-y-2">
              <h4 className="text-xs font-medium text-muted">Plan Capabilities:</h4>
              <div className="flex flex-wrap gap-2">
                {plan.features.map((feat: string, i: number) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bgSubtle text-xs text-fg border border-border"
                  >
                    <CheckCircle2 size={12} className="text-accent-green" />
                    {feat}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plan Comparison & Checkout Client */}
      <BillingClient
        plans={plansForClient}
        currentPlanSlug={plan.slug}
        activeSubscriptionId={activeSubscription?.id}
        isCanceled={Boolean(activeSubscription?.cancel_at_period_end)}
        isTrialExpired={trialStatus?.status === "expired"}
        manualConfig={manualConfig}
        recentPayments={recentPaymentsForClient}
      />

      {/* Invoices & Payment History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt size={18} className="text-brand" />
            Invoices &amp; Billing History
          </CardTitle>
          <CardDescription>
            Recent receipts and transaction status for your account.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-0">
          {userPayments.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted space-y-2">
              <AlertCircle size={20} className="mx-auto text-muted/60" />
              <div>No invoice history available yet.</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="pb-3 font-medium">Invoice #</th>
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Amount</th>
                    <th className="pb-3 font-medium">Method</th>
                    <th className="pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {userPayments.map((p: any) => {
                    const dateStr = p.created_at
                      ? new Date(p.created_at).toLocaleDateString()
                      : "—";
                    const details =
                      p.method_details && typeof p.method_details === "object"
                        ? (p.method_details as Record<string, any>)
                        : {};
                    const isSubmittedPending =
                      p.status === "pending" && Boolean(details.submitted_at || details.transaction_id);

                    return (
                      <tr key={p.id} className="hover:bg-surfaceHover transition">
                        <td className="py-3 font-mono font-medium text-fg">
                          <div>{p.invoice_number}</div>
                          {details.plan_name && (
                            <div className="text-[11px] font-sans text-muted">
                              {details.plan_name} ({details.interval === "yearly" ? "Yearly" : "Monthly"})
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-muted">{dateStr}</td>
                        <td className="py-3 font-mono font-medium text-fg">
                          <div>
                            {p.currency} {Number(p.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </div>
                          {details.bdt_amount ? (
                            <div className="text-[11px] text-muted">
                              BDT {Number(details.bdt_amount).toLocaleString()}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 text-muted">
                          <div className="capitalize font-medium text-fg">
                            {details.method || p.provider}
                          </div>
                          {details.transaction_id && (
                            <div className="text-[11px] font-mono text-muted">
                              TrxID: {details.transaction_id}
                            </div>
                          )}
                          {details.sender_number && (
                            <div className="text-[11px] text-muted">
                              From: {details.sender_number}
                            </div>
                          )}
                        </td>
                        <td className="py-3 space-y-1">
                          {p.status === "succeeded" ? (
                            <Badge variant="success" size="sm">Approved</Badge>
                          ) : isSubmittedPending ? (
                            <Badge variant="warning" size="sm">Waiting for Review</Badge>
                          ) : p.status === "pending" ? (
                            <Badge variant="neutral" size="sm">Awaiting Submission</Badge>
                          ) : p.status === "refunded" ? (
                            <Badge variant="warning" size="sm">Refunded</Badge>
                          ) : (
                            <Badge variant="danger" size="sm">Rejected</Badge>
                          )}
                          {p.status === "failed" && details.rejection_reason && (
                            <div className="text-[11px] text-danger max-w-xs">
                              Reason: {details.rejection_reason}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
