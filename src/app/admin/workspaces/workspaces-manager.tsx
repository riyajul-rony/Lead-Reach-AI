"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle, PauseCircle, PlayCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  sending_status: string;
  pause_reason?: string | null;
  paused_at?: string | null;
  created_at: string;
  user?: {
    id: string;
    email: string;
    name?: string | null;
    plan?: string | null;
    status?: string | null;
  } | null;
}

interface AdminActionRow {
  id: string;
  admin_id?: string | null;
  action: string;
  reason?: string | null;
  target_user_id?: string | null;
  workspace_id?: string | null;
  account_id?: string | null;
  created_at: string;
}

export function WorkspacesManager({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<WorkspaceRow[]>([]);
  const [recentActions, setRecentActions] = useState<AdminActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [pauseTarget, setPauseTarget] = useState<WorkspaceRow | null>(null);
  const [pauseReason, setPauseReason] = useState("");
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({
        page: String(page),
        limit: "20",
      });
      if (query.trim()) sp.set("q", query.trim());
      if (statusFilter) sp.set("status", statusFilter);

      const res = await fetch(`/api/v1/admin/workspaces?${sp.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to load workspaces");
      }
      setItems(json.data?.items || []);
      setTotalPages(json.data?.pagination?.totalPages || 1);
      setRecentActions(json.data?.recentActions || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }, [page, query, statusFilter]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleConfirmPause = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pauseTarget || !pauseReason.trim()) return;
    setSubmittingId(pauseTarget.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/v1/admin/workspaces/${pauseTarget.id}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: pauseReason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to pause workspace");
      setPauseTarget(null);
      setPauseReason("");
      await fetchWorkspaces();
    } catch (err: any) {
      setActionError(err?.message || "Failed to pause workspace");
    } finally {
      setSubmittingId(null);
    }
  };

  const handleResume = async (ws: WorkspaceRow) => {
    setSubmittingId(ws.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/v1/admin/workspaces/${ws.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resume workspace");
      await fetchWorkspaces();
    } catch (err: any) {
      setActionError(err?.message || "Failed to resume workspace");
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-fg">Workspaces &amp; Sending Controls</h1>
          <p className="text-xs text-muted">
            Pause or resume all campaign, follow-up, and warm-up sending for a customer workspace.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchWorkspaces}
          disabled={loading}
          className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="glass rounded-xl p-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          aria-label="Search workspaces or owner email"
          value={query}
          onChange={(e) => {
            setPage(1);
            setQuery(e.target.value);
          }}
          placeholder="Search workspace name or owner email..."
          className="input h-9 text-xs flex-1 min-w-[220px]"
        />
        <select
          aria-label="Filter by sending status"
          value={statusFilter}
          onChange={(e) => {
            setPage(1);
            setStatusFilter(e.target.value);
          }}
          className="input h-9 text-xs w-48"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused_by_admin">Paused by Admin</option>
        </select>
      </div>

      {actionError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-500 flex items-center gap-2">
          <AlertTriangle size={14} /> {actionError}
        </div>
      )}

      {/* Workspace List */}
      <div className="glass rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-muted">Loading workspaces...</div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-rose-500">{error}</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted">No workspaces matched your filters.</div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((ws) => {
              const isPaused = ws.sending_status === "paused_by_admin";
              return (
                <div
                  key={ws.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-fg">{ws.name}</span>
                      <Badge variant={isPaused ? "danger" : "success"} size="sm">
                        {isPaused ? "Paused by Admin" : "Active"}
                      </Badge>
                      {ws.user?.plan && (
                        <Badge variant="neutral" size="sm">
                          {ws.user.plan}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted flex flex-wrap items-center gap-2">
                      <span>Owner:</span>
                      {ws.user ? (
                        <Link
                          href={`/admin/users/${ws.user.id}`}
                          className="font-mono text-fg hover:underline"
                        >
                          {ws.user.email}
                        </Link>
                      ) : (
                        <span className="font-mono">{ws.user_id}</span>
                      )}
                      {isPaused && ws.paused_at && (
                        <span>· Paused at {new Date(ws.paused_at).toLocaleString()}</span>
                      )}
                    </div>
                    {isPaused && ws.pause_reason && (
                      <p className="text-xs text-rose-500">
                        Reason: {ws.pause_reason}
                      </p>
                    )}
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-2 shrink-0">
                      {isPaused ? (
                        <button
                          type="button"
                          onClick={() => handleResume(ws)}
                          disabled={submittingId === ws.id}
                          className="btn btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer"
                        >
                          <PlayCircle size={13} />
                          {submittingId === ws.id ? "Resuming..." : "Resume Sending"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setPauseTarget(ws);
                            setPauseReason("");
                            setActionError(null);
                          }}
                          className="btn btn-secondary text-xs px-3 py-1.5 text-rose-500 flex items-center gap-1.5 cursor-pointer"
                        >
                          <PauseCircle size={13} /> Pause Sending
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Audit History */}
      <div className="glass rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
          <ShieldAlert size={15} className="text-amber-500" /> Recent Admin Sending Audit Log
        </h2>
        {recentActions.length === 0 ? (
          <p className="text-xs text-muted italic">No admin sending actions recorded yet.</p>
        ) : (
          <div className="divide-y divide-border text-xs">
            {recentActions.map((act) => (
              <div key={act.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono font-semibold text-fg">{act.action}</span>
                  {act.reason && <span className="text-muted"> — {act.reason}</span>}
                </div>
                <span className="text-[11px] text-muted">
                  {new Date(act.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pause Reason Modal */}
      {pauseTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pause-workspace-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <form
            onSubmit={handleConfirmPause}
            className="glass rounded-xl max-w-md w-full p-5 space-y-4 bg-surface border border-border"
          >
            <div>
              <h3 id="pause-workspace-modal-title" className="text-sm font-bold text-fg">Pause Workspace Sending</h3>
              <p className="text-xs text-muted mt-1">
                All outbound campaigns, follow-ups, and warm-up traffic for{" "}
                <strong>{pauseTarget.user?.email || pauseTarget.name}</strong> will pause immediately. Existing jobs remain queued safely.
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-fg block mb-1">
                Reason (shown to tenant &amp; recorded in audit log)
              </label>
              <textarea
                required
                minLength={3}
                rows={3}
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="e.g. High bounce spike detected; awaiting list verification"
                className="input w-full text-xs resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPauseTarget(null)}
                className="btn btn-secondary text-xs px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingId === pauseTarget.id}
                className="btn btn-primary text-xs px-3 py-1.5"
              >
                {submittingId === pauseTarget.id ? "Pausing..." : "Confirm Pause"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
