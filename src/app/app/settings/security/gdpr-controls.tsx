"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Trash2, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GdprControlsProps {
  hasPassword: boolean;
  userEmail: string;
}

export function GdprControls({ hasPassword, userEmail }: GdprControlsProps) {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    setExportSuccess(false);

    try {
      const res = await fetch("/api/v1/account/export", { method: "GET" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to export data.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "leadreach-account-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 5000);
    } catch (err: any) {
      setExportError(err?.message || "Failed to export account data.");
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError(null);
    setDeleting(true);

    try {
      const res = await fetch("/api/v1/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasPassword ? { password } : { confirmation }
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to delete account.");
      }

      router.push("/login?deleted=1");
      router.refresh();
    } catch (err: any) {
      setDeleteError(err?.message || "Failed to delete account.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* GDPR Data Export */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="text-brand" size={18} /> Export My Data (GDPR)
          </CardTitle>
          <CardDescription>
            Download a JSON copy of your profile, leads, outreach campaigns, and connected account metadata. Passwords, API keys, and OAuth secrets are strictly excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {exportSuccess && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 size={15} /> Your JSON export has been downloaded.
            </div>
          )}
          {exportError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
              {exportError}
            </div>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <>
                <Loader2 size={14} className="mr-1.5 animate-spin" /> Preparing Export...
              </>
            ) : (
              <>
                <Download size={14} className="mr-1.5" /> Download My Data (JSON)
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Danger Zone: Self-Service Account Deletion */}
      <Card className="border-red-500/30">
        <CardHeader>
          <CardTitle className="text-red-600 dark:text-red-400 flex items-center gap-2">
            <AlertTriangle size={18} /> Danger Zone — Delete Account
          </CardTitle>
          <CardDescription>
            Permanently delete your account ({userEmail}), stop all active campaigns, and erase all leads, messages, and encrypted credentials. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {!confirmOpen ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmOpen(true);
                setDeleteError(null);
              }}
            >
              <Trash2 size={14} className="mr-1.5" /> Delete My Account
            </Button>
          ) : (
            <form onSubmit={handleDelete} className="space-y-4 max-w-md rounded-lg border border-red-500/30 bg-red-500/5 p-4">
              {deleteError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
                  {deleteError}
                </div>
              )}

              {hasPassword ? (
                <Input
                  label="Confirm Current Password"
                  type="password"
                  placeholder="Enter your password to confirm deletion"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              ) : (
                <Input
                  label='Type "DELETE" to confirm'
                  type="text"
                  placeholder="DELETE"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  required
                  helperText="OAuth-only account confirmation required."
                />
              )}

              <div className="flex items-center gap-2">
                <Button type="submit" variant="danger" size="sm" disabled={deleting}>
                  {deleting ? (
                    <>
                      <Loader2 size={14} className="mr-1.5 animate-spin" /> Deleting Account...
                    </>
                  ) : (
                    "Permanently Delete Account"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmOpen(false);
                    setPassword("");
                    setConfirmation("");
                    setDeleteError(null);
                  }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
