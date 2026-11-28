"use client";

import React, { useState } from "react";
import { Check, Clock, Loader2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { approveManualPaymentAction, rejectManualPaymentAction } from "./billing-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";

export interface PendingManualPaymentItem {
  id: string;
  invoiceNumber: string;
  userId: string;
  userName: string;
  userEmail: string;
  planName: string;
  interval: "monthly" | "yearly";
  amount: number;
  currency: string;
  bdtAmount: number | null;
  method: string;
  transactionId: string;
  senderNumber: string;
  userNote: string;
  submittedAt: string;
}

export function PendingReviewQueue({ items }: { items: PendingManualPaymentItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingManualPaymentItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  const handleApprove = async (item: PendingManualPaymentItem) => {
    if (busyId) return;
    setBusyId(item.id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await approveManualPaymentAction(item.id);
      if (!res.success) {
        setErrorMsg((res as any).error || "Failed to approve payment.");
      } else {
        setSuccessMsg(
          (res as any).alreadyApproved
            ? `Invoice ${item.invoiceNumber} was already approved.`
            : `Approved ${item.invoiceNumber} and activated ${item.planName} for ${item.userEmail}.`
        );
        router.refresh();
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to approve payment.");
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectTarget) return;
    const clean = rejectReason.trim();
    if (clean.length < 3) {
      setRejectError("Please enter a short reason (at least 3 characters).");
      return;
    }

    setBusyId(rejectTarget.id);
    setRejectError(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await rejectManualPaymentAction(rejectTarget.id, clean);
      if (!res.success) {
        setRejectError((res as any).error || "Failed to reject payment.");
      } else {
        setSuccessMsg(`Rejected ${rejectTarget.invoiceNumber} and notified ${rejectTarget.userEmail}.`);
        setRejectTarget(null);
        setRejectReason("");
        router.refresh();
      }
    } catch (err: any) {
      setRejectError(err?.message || "Failed to reject payment.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="p-4 sm:p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-amber-500" />
          <h2 className="text-sm font-semibold text-fg">Pending Manual Payments Review Queue</h2>
          <Badge variant={items.length > 0 ? "warning" : "neutral"} size="sm">
            {items.length} pending
          </Badge>
        </div>
        <span className="text-xs text-muted">
          Approving activates the user&apos;s plan immediately (30d monthly / 365d yearly).
        </span>
      </div>

      {errorMsg && (
        <div className="mx-4 mt-4 rounded-lg border border-danger/30 bg-dangerBg px-3 py-2 text-xs text-danger">
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="mx-4 mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
          {successMsg}
        </div>
      )}

      {items.length === 0 ? (
        <div className="p-8 text-center text-xs text-muted">
          No pending manual payments waiting for review.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-bgSubtle border-b border-border text-muted">
              <tr>
                <th className="py-3 px-4 font-semibold">User</th>
                <th className="py-3 px-4 font-semibold">Plan / Interval</th>
                <th className="py-3 px-4 font-semibold">Amount</th>
                <th className="py-3 px-4 font-semibold">Method &amp; Sender</th>
                <th className="py-3 px-4 font-semibold">Transaction ID</th>
                <th className="py-3 px-4 font-semibold">Submitted</th>
                <th className="py-3 px-4 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => {
                const isBusy = busyId === item.id;
                return (
                  <tr key={item.id} className="hover:bg-surfaceHover transition">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-fg">{item.userName}</div>
                      <div className="text-[11px] text-muted">{item.userEmail}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-fg">{item.planName}</div>
                      <div className="text-[11px] text-muted capitalize">{item.interval}</div>
                    </td>
                    <td className="py-3.5 px-4 font-mono">
                      <div className="font-semibold text-fg">
                        {item.currency} {item.amount.toFixed(2)}
                      </div>
                      {item.bdtAmount !== null && (
                        <div className="text-[11px] text-muted">
                          BDT {item.bdtAmount.toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="capitalize font-medium text-fg">{item.method}</div>
                      <div className="text-[11px] font-mono text-muted">{item.senderNumber || "—"}</div>
                      {item.userNote && (
                        <div className="text-[11px] text-muted truncate max-w-[180px]" title={item.userNote}>
                          Note: {item.userNote}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-mono">
                      <div className="font-semibold text-fg">{item.transactionId || "Not submitted"}</div>
                      <div className="text-[10px] text-muted">{item.invoiceNumber}</div>
                    </td>
                    <td className="py-3.5 px-4 text-muted">
                      {new Date(item.submittedAt).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => handleApprove(item)}
                        >
                          {isBusy ? (
                            <Loader2 size={13} className="animate-spin mr-1" />
                          ) : (
                            <Check size={13} className="mr-1" />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={isBusy}
                          onClick={() => {
                            setRejectTarget(item);
                            setRejectReason("");
                            setRejectError(null);
                          }}
                        >
                          <XCircle size={13} className="mr-1" />
                          Reject
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        title={rejectTarget ? `Reject Payment ${rejectTarget.invoiceNumber}` : "Reject Payment"}
        description={
          rejectTarget
            ? `Provide a short reason for ${rejectTarget.userEmail}. This reason will be emailed and shown on their billing page.`
            : ""
        }
        confirmLabel="Confirm Reject"
        confirmVariant="danger"
        loading={Boolean(rejectTarget && busyId === rejectTarget.id)}
        onConfirm={handleConfirmReject}
      >
        <div className="space-y-2">
          {rejectError && (
            <div className="rounded-lg border border-danger/30 bg-dangerBg px-3 py-2 text-xs text-danger">
              {rejectError}
            </div>
          )}
          <label className="block text-xs font-medium text-text-muted">Rejection Reason</label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="e.g. Transaction ID not found in bKash statement"
            className="w-full rounded-[6px] border border-border-input bg-surface px-3 py-2 text-xs text-text placeholder:text-text-subtle focus:border-focus-ring focus:outline-none"
          />
        </div>
      </Dialog>
    </div>
  );
}
