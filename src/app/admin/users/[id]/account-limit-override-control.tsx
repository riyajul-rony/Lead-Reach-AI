"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";

export interface AdminEmailAccountSummary {
  id: string;
  from_email: string;
  label: string | null;
  status: string;
  adaptive_limit?: {
    accountType: string;
    ageTierLabel: string;
    ageVerificationFailed: boolean;
    effectiveDailyLimit: number;
    planCeiling: number;
    usedToday: number;
    healthStatus: string;
    userDailyLimit: number | null;
    adminDailyLimitOverride: number | null;
  } | null;
}

export function AccountLimitOverrideControl({
  accounts,
  systemMaxDailyLimit,
  canEdit,
}: {
  accounts: AdminEmailAccountSummary[];
  systemMaxDailyLimit: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [inputs, setInputs] = useState<Record<string, { limit: string; reason: string }>>(() => {
    const initial: Record<string, { limit: string; reason: string }> = {};
    for (const acc of accounts) {
      initial[acc.id] = {
        limit:
          acc.adaptive_limit?.adminDailyLimitOverride != null
            ? String(acc.adaptive_limit.adminDailyLimitOverride)
            : "",
        reason: "",
      };
    }
    return initial;
  });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const submitOverride = async (accountId: string, clear = false) => {
    const entry = inputs[accountId] || { limit: "", reason: "" };
    const overrideLimit = clear
      ? null
      : entry.limit.trim() === ""
        ? null
        : Number(entry.limit);

    if (
      overrideLimit !== null &&
      (!Number.isFinite(overrideLimit) ||
        overrideLimit < 5 ||
        overrideLimit > systemMaxDailyLimit)
    ) {
      setFeedback((prev) => ({
        ...prev,
        [accountId]: {
          ok: false,
          msg: `Override must be between 5 and ${systemMaxDailyLimit}.`,
        },
      }));
      return;
    }

    setSavingId(accountId);
    setFeedback((prev) => {
      const next = { ...prev };
      delete next[accountId];
      return next;
    });

    try {
      const res = await fetch(`/api/v1/admin/email-accounts/${accountId}/limit-override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrideLimit,
          reason: entry.reason.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to update daily limit override");
      }

      if (clear) {
        setInputs((prev) => ({
          ...prev,
          [accountId]: { limit: "", reason: "" },
        }));
      }

      setFeedback((prev) => ({
        ...prev,
        [accountId]: {
          ok: true,
          msg:
            overrideLimit === null
              ? `Cleared override. Effective limit is now ${json.data?.newLimit ?? "--"}/day.`
              : `Saved override (${overrideLimit}/day). Effective limit: ${json.data?.newLimit ?? "--"}/day.`,
        },
      }));
      router.refresh();
    } catch (err: any) {
      setFeedback((prev) => ({
        ...prev,
        [accountId]: {
          ok: false,
          msg: err?.message || "Failed to save override",
        },
      }));
    } finally {
      setSavingId(null);
    }
  };

  if (accounts.length === 0) {
    return (
      <p className="text-xs text-muted italic">
        This user has no connected sender mailboxes yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {accounts.map((acc) => {
        const entry = inputs[acc.id] || { limit: "", reason: "" };
        const fb = feedback[acc.id];
        const al = acc.adaptive_limit;
        return (
          <div
            key={acc.id}
            className="rounded-lg border border-border bg-bgSubtle p-3 flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold font-mono text-fg">
                    {acc.from_email}
                  </span>
                  <Badge variant={acc.status === "active" ? "success" : "warning"} size="sm">
                    {acc.status}
                  </Badge>
                  {al && (
                    <Badge variant="neutral" size="sm">
                      {al.accountType} · {al.ageTierLabel}
                    </Badge>
                  )}
                </div>
                {al && (
                  <p className="text-[11px] text-muted">
                    Effective today: <strong className="text-fg">{al.effectiveDailyLimit}/day</strong> ·
                    Used today: <strong className="text-fg">{al.usedToday}</strong> ·
                    Ceiling: <strong className="text-fg">{al.planCeiling}/day</strong> ·
                    Health: <strong className="text-fg">{al.healthStatus}</strong>
                    {al.userDailyLimit !== null ? ` · User cap: ${al.userDailyLimit}/day` : ""}
                    {al.adminDailyLimitOverride !== null
                      ? ` · Current override: ${al.adminDailyLimitOverride}/day`
                      : ""}
                  </p>
                )}
              </div>
            </div>

            {canEdit && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <label className="text-[10px] font-semibold text-muted uppercase block mb-1">
                    Override (5–{systemMaxDailyLimit})
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={systemMaxDailyLimit}
                    placeholder="Auto"
                    value={entry.limit}
                    onChange={(e) =>
                      setInputs((prev) => ({
                        ...prev,
                        [acc.id]: { ...entry, limit: e.target.value },
                      }))
                    }
                    className="input h-8 text-xs w-full"
                  />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="text-[10px] font-semibold text-muted uppercase block mb-1">
                    Audit Reason
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Verified warmed Workspace domain"
                    value={entry.reason}
                    onChange={(e) =>
                      setInputs((prev) => ({
                        ...prev,
                        [acc.id]: { ...entry, reason: e.target.value },
                      }))
                    }
                    className="input h-8 text-xs w-full"
                  />
                </div>
                <button
                  type="button"
                  disabled={savingId === acc.id}
                  onClick={() => submitOverride(acc.id, false)}
                  className="btn btn-primary h-8 px-3 text-xs cursor-pointer"
                >
                  {savingId === acc.id ? "Saving..." : "Apply Override"}
                </button>
                {al?.adminDailyLimitOverride != null && (
                  <button
                    type="button"
                    disabled={savingId === acc.id}
                    onClick={() => submitOverride(acc.id, true)}
                    className="btn btn-secondary h-8 px-3 text-xs cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            {fb && (
              <p
                className={`text-xs ${
                  fb.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"
                }`}
              >
                {fb.msg}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
