"use client";

import React, { useState } from "react";
import { Building2, Check, Loader2, Settings2 } from "lucide-react";
import { saveManualPaymentSettingsAction } from "./billing-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { ManualPaymentConfig } from "@/server/billing/manual-settings";

interface ManualSettingsCardProps {
  initialConfig: ManualPaymentConfig;
}

export function ManualSettingsCard({ initialConfig }: ManualSettingsCardProps) {
  const [expanded, setExpanded] = useState(!initialConfig.isConfigured);
  const [bkashNumber, setBkashNumber] = useState(initialConfig.bkashNumber);
  const [nagadNumber, setNagadNumber] = useState(initialConfig.nagadNumber);
  const [bankName, setBankName] = useState(initialConfig.bankName);
  const [bankAccountName, setBankAccountName] = useState(initialConfig.bankAccountName);
  const [bankAccountNumber, setBankAccountNumber] = useState(initialConfig.bankAccountNumber);
  const [usdToBdtRate, setUsdToBdtRate] = useState(
    initialConfig.usdToBdtRate ? String(initialConfig.usdToBdtRate) : ""
  );
  const [note, setNote] = useState(initialConfig.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [configured, setConfigured] = useState(initialConfig.isConfigured);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMsg(null);

    try {
      const res = await saveManualPaymentSettingsAction({
        bkashNumber,
        nagadNumber,
        bankName,
        bankAccountName,
        bankAccountNumber,
        usdToBdtRate: usdToBdtRate.trim() ? Number(usdToBdtRate) : null,
        note,
      });

      if (!res.success) {
        setError(res.error || "Failed to save payment settings.");
      } else {
        setConfigured(Boolean(res.config?.isConfigured));
        setSavedMsg("Manual payment instructions updated.");
      }
    } catch (err: any) {
      setError(err?.message || "Failed to save payment settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-brand" />
            <h2 className="text-sm font-semibold text-fg">Manual Payment Instructions &amp; Exchange Rate</h2>
            {configured ? (
              <Badge variant="success" size="sm" dot>Configured</Badge>
            ) : (
              <Badge variant="warning" size="sm">Not Configured</Badge>
            )}
          </div>
          <p className="text-xs text-muted">
            Configure the bKash, Nagad, or bank transfer accounts and optional USD-to-BDT rate shown to users on the billing page.
          </p>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <Settings2 size={13} className="mr-1.5" />
          {expanded ? "Hide Settings" : "Edit Instructions"}
        </Button>
      </div>

      {expanded && (
        <form onSubmit={handleSave} className="border-t border-border p-4 sm:p-5 space-y-4 bg-bgSubtle/40">
          {error && (
            <div className="rounded-lg border border-danger/30 bg-dangerBg px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
          {savedMsg && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <Check size={14} /> {savedMsg}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="bKash Number"
              value={bkashNumber}
              onChange={(e) => setBkashNumber(e.target.value)}
              placeholder="e.g. 01XXXXXXXXX (Personal/Merchant)"
              maxLength={40}
            />
            <Input
              label="Nagad Number"
              value={nagadNumber}
              onChange={(e) => setNagadNumber(e.target.value)}
              placeholder="e.g. 01XXXXXXXXX (Personal/Merchant)"
              maxLength={40}
            />
            <Input
              label="USD to BDT Exchange Rate (Optional)"
              type="number"
              step="0.01"
              min="0"
              value={usdToBdtRate}
              onChange={(e) => setUsdToBdtRate(e.target.value)}
              placeholder="e.g. 120"
              helperText="Leave blank to show USD only"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Bank Name"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g. Dutch-Bangla Bank"
              maxLength={120}
            />
            <Input
              label="Bank Account Name"
              value={bankAccountName}
              onChange={(e) => setBankAccountName(e.target.value)}
              placeholder="Account holder name"
              maxLength={120}
            />
            <Input
              label="Bank Account Number"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              placeholder="Account number"
              maxLength={60}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Optional Note for Customers
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Include your invoice number as reference. Verification usually completes within 2 hours."
              className="w-full rounded-[6px] border border-border-input bg-surface px-3 py-2 text-xs text-text placeholder:text-text-subtle focus:border-focus-ring focus:outline-none focus:ring-2 focus:ring-focus-ring/20"
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving && <Loader2 size={13} className="animate-spin mr-1.5" />}
              Save Payment Settings
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
