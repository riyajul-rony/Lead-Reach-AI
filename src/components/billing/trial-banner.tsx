import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock, Sparkles } from "lucide-react";
import type { TrialStatus } from "@/server/billing/trial";
import { Button } from "@/components/ui/button";

interface TrialBannerProps {
  trial: TrialStatus | null;
}

export function TrialBanner({ trial }: TrialBannerProps) {
  if (!trial || trial.status === "not_applicable") {
    return null;
  }

  const formattedEnd = trial.endsAt
    ? new Date(trial.endsAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  if (trial.status === "expired") {
    return (
      <div
        role="alert"
        className="mb-6 rounded-xl border border-danger/40 bg-dangerBg px-4 py-3.5 text-sm text-fg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
      >
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 shrink-0 text-danger">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-fg">Your 14-day free trial has ended</div>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              Campaign sending, lead searches, enrichment, and social auto-posting are paused.
              Your existing data and exports remain accessible.
            </p>
          </div>
        </div>
        <Link href="/app/settings/billing" className="shrink-0 self-start sm:self-center">
          <Button variant="primary" size="sm">
            Upgrade Plan <ArrowRight size={13} className="ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  const isUrgent = trial.daysLeft <= 4;
  const daysLabel =
    trial.daysLeft === 0
      ? "Free trial ends today"
      : trial.daysLeft === 1
      ? "1 day left in your free trial"
      : `${trial.daysLeft} days left in your free trial`;

  if (isUrgent) {
    return (
      <div
        role="status"
        className="mb-6 rounded-xl border border-warning/40 bg-warningBg px-4 py-3 text-sm text-fg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
      >
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 shrink-0 text-warning">
            <Clock size={17} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-fg">{daysLabel}</div>
            <p className="text-xs text-muted mt-0.5">
              Upgrade to a paid plan{formattedEnd ? ` before ${formattedEnd}` : ""} to avoid interruption to your campaigns and lead workflows.
            </p>
          </div>
        </div>
        <Link href="/app/settings/billing" className="shrink-0 self-start sm:self-center">
          <Button variant="primary" size="sm">
            Upgrade Now <ArrowRight size={13} className="ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-5 rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-fg flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles size={14} className="text-brand shrink-0" />
        <span className="truncate">
          <strong className="font-semibold">{daysLabel}</strong>
          {formattedEnd ? (
            <span className="text-muted"> · Ends {formattedEnd}</span>
          ) : null}
        </span>
      </div>
      <Link
        href="/app/settings/billing"
        className="inline-flex items-center gap-1 font-medium text-brand hover:underline shrink-0 self-start sm:self-center"
      >
        View paid plans <ArrowRight size={12} />
      </Link>
    </div>
  );
}
