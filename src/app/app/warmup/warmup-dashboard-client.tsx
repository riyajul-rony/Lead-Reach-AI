"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Flame,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { GmailAppPasswordGuide } from "@/components/warmup/gmail-app-password-guide";
import { GmailAppPasswordModal } from "@/components/warmup/gmail-app-password-modal";

export interface WarmupAccountItem {
  id: string;
  label: string;
  provider: "smtp" | "gmail_api" | string;
  from_email: string;
  status: string;
  imap_host?: string | null;
  reply_inbox_account_id?: string | null;
  has_imap_password?: boolean;
  has_reply_detection?: boolean;
  warmup_enabled?: boolean;
  warmup_day?: number;
  warmup_start_limit?: number;
  warmup_daily_increment?: number;
  warmup_max_limit?: number;
  effective_daily_limit?: number;
  sentToday?: number;
}

interface WarmupLogEntry {
  id: string;
  from_account_id: string;
  to_account_id: string;
  subject: string;
  status: "sent" | "replied" | "failed" | string;
  sent_at?: string | null;
  replied_at?: string | null;
  error?: string | null;
  from_account?: { id: string; from_email: string; label?: string } | null;
  to_account?: { id: string; from_email: string; label?: string } | null;
}

interface WarmupLogsPayload {
  items: WarmupLogEntry[];
  total: number;
  page: number;
  limit: number;
  summary?: {
    poolCount: number;
    imapCapableCount: number;
    poolActive: boolean;
    sentToday: number;
    repliedToday: number;
  };
}

interface WarmupDraftValues {
  start: number;
  increment: number;
  max: number;
}

export function WarmupDashboardClient({
  initialAccounts,
  initialLogs,
  initialError = null,
  workerWarning = null,
}: {
  initialAccounts: WarmupAccountItem[];
  initialLogs: WarmupLogsPayload;
  initialError?: string | null;
  workerWarning?: string | null;
}) {
  const [accounts, setAccounts] = useState<WarmupAccountItem[]>(initialAccounts);
  const [logsData, setLogsData] = useState<WarmupLogsPayload>(initialLogs);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);
  const [logsError, setLogsError] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [savingLimitsId, setSavingLimitsId] = useState<string | null>(null);
  const [savedNoticeId, setSavedNoticeId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WarmupDraftValues>>({});

  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [connectModalInitialEmail, setConnectModalInitialEmail] = useState("");

  const refreshAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/v1/email-accounts");
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to load email accounts.");
      }
      setAccounts(json.data || []);
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to load email accounts.");
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  const refreshLogs = useCallback(async (page = 1) => {
    setLoadingLogs(true);
    setLogsError(null);
    try {
      const res = await fetch(`/api/v1/email-accounts/warmup-logs?page=${page}&limit=15`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to load warm-up logs.");
      }
      if (json.data) {
        setLogsData(json.data);
      }
    } catch (err: any) {
      setLogsError(err?.message || "Failed to load warm-up logs.");
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshAccounts(), refreshLogs(logsData.page || 1)]);
  }, [refreshAccounts, refreshLogs, logsData.page]);

  const isAccountImapReady = (acc: WarmupAccountItem) =>
    acc.has_reply_detection ??
    Boolean((acc.imap_host && acc.has_imap_password) || acc.reply_inbox_account_id);

  const activeWarmupAccounts = accounts.filter(
    (a) => a.status === "active" && Boolean(a.warmup_enabled)
  );
  const readyCount = activeWarmupAccounts.length;
  const imapReadyCount = activeWarmupAccounts.filter(isAccountImapReady).length;
  const poolReady = readyCount >= 2;

  const getDraft = (acc: WarmupAccountItem): WarmupDraftValues =>
    drafts[acc.id] || {
      start: acc.warmup_start_limit ?? 10,
      increment: acc.warmup_daily_increment ?? 5,
      max: acc.warmup_max_limit ?? 50,
    };

  const hasUnsavedChanges = (acc: WarmupAccountItem): boolean => {
    const d = drafts[acc.id];
    if (!d) return false;
    return (
      d.start !== (acc.warmup_start_limit ?? 10) ||
      d.increment !== (acc.warmup_daily_increment ?? 5) ||
      d.max !== (acc.warmup_max_limit ?? 50)
    );
  };

  const updateDraftField = (
    acc: WarmupAccountItem,
    field: keyof WarmupDraftValues,
    value: number
  ) => {
    const current = getDraft(acc);
    setDrafts((prev) => ({
      ...prev,
      [acc.id]: {
        ...current,
        [field]: Number.isFinite(value) ? value : current[field],
      },
    }));
  };

  const handleToggleWarmup = async (acc: WarmupAccountItem) => {
    const nextEnabled = !acc.warmup_enabled;
    setTogglingId(acc.id);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/email-accounts/${acc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warmup_enabled: nextEnabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to toggle warm-up.");
      }
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === acc.id
            ? {
                ...a,
                warmup_enabled: nextEnabled,
                effective_daily_limit:
                  json.data?.effective_daily_limit ?? a.effective_daily_limit,
              }
            : a
        )
      );
      await refreshLogs(logsData.page || 1);
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to toggle warm-up setting.");
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveLimits = async (acc: WarmupAccountItem) => {
    const d = getDraft(acc);
    const start = Math.max(1, Math.min(100, Number(d.start) || 10));
    const increment = Math.max(1, Math.min(50, Number(d.increment) || 5));
    const max = Math.max(start, Math.min(500, Number(d.max) || 50));

    setSavingLimitsId(acc.id);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/email-accounts/${acc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warmup_start_limit: start,
          warmup_daily_increment: increment,
          warmup_max_limit: max,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to save warm-up limits.");
      }
      await refreshAccounts();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[acc.id];
        return next;
      });
      setSavedNoticeId(acc.id);
      setTimeout(() => {
        setSavedNoticeId((cur) => (cur === acc.id ? null : cur));
      }, 2500);
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to save warm-up limits.");
    } finally {
      setSavingLimitsId(null);
    }
  };

  const totalPages = Math.max(
    1,
    Math.ceil((logsData.total || 0) / (logsData.limit || 15))
  );

  return (
    <div className="space-y-6">
      {/* Top Page Header */}
      <PageHeader
        title="Email Warm-up"
        description="Gradually build sender reputation across your own connected inboxes before launching high-volume outreach."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/app/outreach/email-accounts">
              <Button variant="secondary" size="sm" rightIcon={<ArrowRight size={13} />}>
                All Sender Inboxes
              </Button>
            </Link>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={refreshAll}
              disabled={loadingAccounts || loadingLogs}
              icon={
                <RefreshCw
                  size={13}
                  className={loadingAccounts || loadingLogs ? "animate-spin" : ""}
                />
              }
            >
              Refresh
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                setConnectModalInitialEmail("");
                setIsConnectModalOpen(true);
              }}
              icon={<Plus size={14} />}
            >
              + Connect Gmail (App Password)
            </Button>
          </div>
        }
      />

      {/* Worker / Scheduler Warning Banner */}
      {workerWarning && (
        <div
          role="alert"
          className="rounded-xl p-4 bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-500" />
          <div>
            <div className="font-semibold">Warm-up Schedulers Not Active</div>
            <div className="mt-0.5">{workerWarning}</div>
          </div>
        </div>
      )}

      {/* Readiness & Private Pool Overview Card */}
      <div className="glass rounded-xl p-5 border border-border space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${
                poolReady
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
              }`}
            >
              <Flame size={20} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-bold text-fg">Self Warm-up Pool Readiness</h2>
                <Badge variant={poolReady ? "success" : "warning"} size="sm" dot>
                  {poolReady
                    ? `${readyCount} accounts active — Pool Active`
                    : `${readyCount}/2 accounts ready — enable Warm-up on at least 2 accounts to start`}
                </Badge>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                This is a private <strong className="text-fg">Self Warm-up Pool</strong> operating strictly between your own connected active accounts (not an external third-party warm-up network). Automated replies require <strong className="text-fg">App Password + IMAP</strong> configured on receiving accounts.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 shrink-0 text-center">
            <div className="px-3 py-2 rounded-lg border border-border bg-bgSubtle">
              <div className="text-base font-bold font-mono text-fg">{readyCount}</div>
              <div className="text-[10px] text-muted uppercase">Warm-up ON</div>
            </div>
            <div className="px-3 py-2 rounded-lg border border-border bg-bgSubtle">
              <div className="text-base font-bold font-mono text-fg">{imapReadyCount}</div>
              <div className="text-[10px] text-muted uppercase">IMAP Auto-Reply</div>
            </div>
            <div className="px-3 py-2 rounded-lg border border-border bg-bgSubtle">
              <div className="text-base font-bold font-mono text-fg">
                {logsData.summary?.sentToday ?? 0} / {logsData.summary?.repliedToday ?? 0}
              </div>
              <div className="text-[10px] text-muted uppercase">Sent / Replied Today</div>
            </div>
          </div>
        </div>
      </div>

      {/* Global Error Alert */}
      {errorMsg && (
        <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="font-semibold hover:underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step-by-Step Gmail App Password Guide Card */}
      <GmailAppPasswordGuide />

      {/* Per-Account Easy Warm-up Controls */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-fg">Connected Accounts &amp; Warm-up Schedules</h2>
          <span className="text-xs text-muted">{accounts.length} account(s)</span>
        </div>

        {loadingAccounts && accounts.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-8 flex items-center justify-center gap-2 text-xs text-muted">
            <Loader2 size={15} className="animate-spin" />
            <span>Loading connected accounts...</span>
          </div>
        ) : accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface p-10 text-center space-y-3">
            <Mail size={28} className="mx-auto text-muted" />
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-fg">No Email Accounts Connected Yet</h3>
              <p className="text-xs text-muted max-w-md mx-auto">
                Connect at least 2 Gmail or SMTP/IMAP inboxes to start warming them up safely inside your private Self Warm-up Pool.
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                setConnectModalInitialEmail("");
                setIsConnectModalOpen(true);
              }}
              icon={<Plus size={14} />}
            >
              + Connect Gmail (App Password)
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((acc) => {
              const imapReady = isAccountImapReady(acc);
              const draft = getDraft(acc);
              const dirty = hasUnsavedChanges(acc);
              const isEnabled = Boolean(acc.warmup_enabled);

              return (
                <div
                  key={acc.id}
                  className="rounded-xl border border-border bg-surface p-4 space-y-3"
                >
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-fg font-mono truncate">
                          {acc.from_email}
                        </span>
                        <Badge
                          variant={acc.status === "active" ? "success" : "warning"}
                          size="sm"
                        >
                          {acc.status === "active" ? "Active" : acc.status}
                        </Badge>
                        {imapReady ? (
                          <Badge variant="success" size="sm">
                            <span className="inline-flex items-center gap-1">
                              <ShieldCheck size={11} /> IMAP Ready (Auto-Reply Enabled)
                            </span>
                          </Badge>
                        ) : (
                          <Badge variant="warning" size="sm">
                            <span className="inline-flex items-center gap-1">
                              <AlertTriangle size={11} /> Send-Only OAuth (Connect with App Password + IMAP for Auto-Replies)
                            </span>
                          </Badge>
                        )}
                      </div>

                      <div className="text-xs text-muted flex items-center gap-3 flex-wrap">
                        <span>{acc.label || "Sender Inbox"}</span>
                        <span className="font-mono text-fg font-semibold">
                          Day {acc.warmup_day || 1}
                        </span>
                        <span>
                          · Today&apos;s effective daily limit:{" "}
                          <strong className="text-fg">
                            {acc.effective_daily_limit ?? acc.warmup_start_limit ?? 10}/day
                          </strong>
                        </span>
                        {acc.sentToday !== undefined && (
                          <span>· Sent today: {acc.sentToday}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      {!imapReady && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setConnectModalInitialEmail(acc.from_email);
                            setIsConnectModalOpen(true);
                          }}
                        >
                          Connect App Password + IMAP
                        </Button>
                      )}

                      <Button
                        type="button"
                        variant={isEnabled ? "primary" : "secondary"}
                        size="sm"
                        disabled={togglingId === acc.id}
                        onClick={() => handleToggleWarmup(acc)}
                        icon={
                          togglingId === acc.id ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Flame size={13} />
                          )
                        }
                      >
                        {isEnabled ? "Warm-up: ON" : "Warm-up: OFF"}
                      </Button>
                    </div>
                  </div>

                  {/* Inline Editable Ramp-Up Limits */}
                  <div className="pt-3 border-t border-border/70 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                    <div className="grid grid-cols-3 gap-3 flex-1 max-w-xl">
                      <div>
                        <label className="text-[10px] font-bold uppercase text-muted block mb-1">
                          Start Limit / Day
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={draft.start}
                          onChange={(e) =>
                            updateDraftField(acc, "start", Number(e.target.value))
                          }
                          className="input w-full text-xs font-mono h-8"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold uppercase text-muted block mb-1">
                          Daily Increment
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={draft.increment}
                          onChange={(e) =>
                            updateDraftField(acc, "increment", Number(e.target.value))
                          }
                          className="input w-full text-xs font-mono h-8"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold uppercase text-muted block mb-1">
                          Max Limit / Day
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={draft.max}
                          onChange={(e) =>
                            updateDraftField(acc, "max", Number(e.target.value))
                          }
                          className="input w-full text-xs font-mono h-8"
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {savedNoticeId === acc.id && (
                        <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-1">
                          <CheckCircle2 size={12} /> Saved
                        </span>
                      )}
                      <Button
                        type="button"
                        variant={dirty ? "primary" : "secondary"}
                        size="sm"
                        disabled={!dirty || savingLimitsId === acc.id}
                        onClick={() => handleSaveLimits(acc)}
                        icon={
                          savingLimitsId === acc.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Save size={12} />
                          )
                        }
                      >
                        {savingLimitsId === acc.id ? "Saving..." : "Save Limits"}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Warm-up Activity Table */}
      <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-fg">Recent Warm-up Activity</h2>
            <p className="text-xs text-muted">
              Latest internal Self Warm-up Pool dispatches and automated IMAP replies.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => refreshLogs(logsData.page || 1)}
            disabled={loadingLogs}
            icon={<RefreshCw size={12} className={loadingLogs ? "animate-spin" : ""} />}
          >
            Refresh Logs
          </Button>
        </div>

        {loadingLogs && logsData.items.length === 0 ? (
          <div className="py-6 flex items-center justify-center gap-2 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading recent warm-up activity...</span>
          </div>
        ) : logsError ? (
          <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
            <AlertCircle size={14} />
            <span>{logsError}</span>
          </div>
        ) : logsData.items.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted border border-dashed border-border rounded-lg">
            No warm-up activity recorded yet. Once 2 or more active accounts have Warm-up ON and background schedulers run, sends and replies will appear here.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[11px] text-muted uppercase">
                    <th className="py-2 pr-4">Sender &rarr; Receiver</th>
                    <th className="py-2 pr-4">Subject</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {logsData.items.map((log) => (
                    <tr key={log.id} className="hover:bg-bgSubtle/50">
                      <td className="py-2.5 pr-4 font-mono text-[11px]">
                        <span className="text-fg font-semibold">
                          {log.from_account?.from_email || log.from_account_id}
                        </span>
                        <span className="text-muted mx-1.5">&rarr;</span>
                        <span className="text-muted">
                          {log.to_account?.from_email || log.to_account_id}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-fg max-w-[260px] truncate">
                        {log.subject}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge
                          variant={
                            log.status === "replied"
                              ? "success"
                              : log.status === "failed"
                              ? "danger"
                              : "neutral"
                          }
                          size="sm"
                        >
                          {log.status === "replied"
                            ? "Replied"
                            : log.status === "failed"
                            ? "Failed"
                            : "Sent"}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-[11px] text-muted whitespace-nowrap">
                        {log.sent_at
                          ? new Date(log.sent_at).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2 border-t border-border text-xs text-muted">
                <span>
                  Page {logsData.page} of {totalPages} ({logsData.total} total)
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={logsData.page <= 1 || loadingLogs}
                    onClick={() => refreshLogs(logsData.page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={logsData.page >= totalPages || loadingLogs}
                    onClick={() => refreshLogs(logsData.page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Gmail App Password Modal */}
      <GmailAppPasswordModal
        isOpen={isConnectModalOpen}
        onClose={() => setIsConnectModalOpen(false)}
        onSuccess={refreshAll}
        initialEmail={connectModalInitialEmail}
        existingAccounts={accounts}
      />
    </div>
  );
}
