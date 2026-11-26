"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GmailAppPasswordGuide,
  stripAppPasswordSpaces,
} from "@/components/warmup/gmail-app-password-guide";

interface GmailAppPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
  initialEmail?: string;
}

export function GmailAppPasswordModal({
  isOpen,
  onClose,
  onSuccess,
  initialEmail = "",
}: GmailAppPasswordModalProps) {
  const [email, setEmail] = useState(initialEmail);
  const [appPassword, setAppPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [label, setLabel] = useState("");
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecurity, setSmtpSecurity] = useState<"starttls" | "ssl" | "tls">("starttls");
  const [imapHost, setImapHost] = useState("imap.gmail.com");
  const [imapPort, setImapPort] = useState(993);
  const [imapSecurity, setImapSecurity] = useState<"ssl" | "tls">("ssl");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    smtpOk: boolean;
    smtpMsg?: string;
    imapOk: boolean;
    imapMsg?: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setEmail(initialEmail || "");
      setAppPassword("");
      setShowPassword(false);
      setShowAdvanced(false);
      setLabel("");
      setSmtpHost("smtp.gmail.com");
      setSmtpPort(587);
      setSmtpSecurity("starttls");
      setImapHost("imap.gmail.com");
      setImapPort(993);
      setImapSecurity("ssl");
      setErrorMsg(null);
      setTestResult(null);
    }
  }, [isOpen, initialEmail]);

  if (!isOpen) return null;

  const cleanEmail = email.trim();
  const cleanPass = stripAppPasswordSpaces(appPassword);

  const handlePasswordChange = (rawVal: string) => {
    setAppPassword(stripAppPasswordSpaces(rawVal));
    setTestResult(null);
    setErrorMsg(null);
  };

  const handleTest = async () => {
    if (!cleanEmail || !cleanPass) return;
    setTesting(true);
    setErrorMsg(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/v1/email-accounts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtp: {
            host: smtpHost.trim(),
            port: smtpPort,
            security: smtpSecurity,
            username: cleanEmail,
            password: cleanPass,
          },
          imap: {
            host: imapHost.trim(),
            port: imapPort,
            security: imapSecurity,
            username: cleanEmail,
            password: cleanPass,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok && !json.data) {
        setErrorMsg(json.error || "Connection test failed.");
        return;
      }

      setTestResult({
        smtpOk: Boolean(json.data?.smtp?.ok),
        smtpMsg: json.data?.smtp?.error || json.data?.smtp?.message,
        imapOk: Boolean(json.data?.imap?.ok),
        imapMsg: json.data?.imap?.error || json.data?.imap?.message,
      });
    } catch (err: any) {
      setErrorMsg(err?.message || "Network error during connection test.");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanEmail || !cleanPass) {
      setErrorMsg("Gmail address and 16-character App Password are required.");
      return;
    }

    setSaving(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/v1/email-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_email: cleanEmail,
          label: label.trim() || undefined,
          smtp_host: smtpHost.trim(),
          smtp_port: smtpPort,
          smtp_security: smtpSecurity,
          smtp_username: cleanEmail,
          smtp_password: cleanPass,
          imap_host: imapHost.trim(),
          imap_port: imapPort,
          imap_security: imapSecurity,
          imap_username: cleanEmail,
          imap_password: cleanPass,
          warmup_enabled: true,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Could not save Gmail account.");
      }

      await onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to save Gmail account.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-surface rounded-xl border border-border w-full max-w-lg max-h-[92vh] overflow-y-auto p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <h3 className="text-base font-bold text-fg flex items-center gap-2">
              <Mail size={16} className="text-primary" />
              <span>Connect Gmail (App Password + IMAP)</span>
            </h3>
            <p className="text-[11px] text-muted mt-0.5">
              Enables both sending and automatic IMAP warm-up / reply detection.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-fg text-sm cursor-pointer px-1"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <GmailAppPasswordGuide compact />

        <form onSubmit={handleSave} className="space-y-3.5">
          <div>
            <label className="text-xs font-semibold text-fg block mb-1">
              Gmail Address <span className="text-danger">*</span>
            </label>
            <input
              type="email"
              required
              placeholder="you@gmail.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setTestResult(null);
              }}
              className="input w-full text-xs font-mono h-9"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-fg">
                16-Character App Password <span className="text-danger">*</span>
              </label>
              <span className="text-[10px] text-muted">
                Spaces stripped automatically ({cleanPass.length} chars)
              </span>
            </div>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                placeholder="abcd efgh ijkl mnop"
                value={appPassword}
                onChange={(e) => handlePasswordChange(e.target.value)}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData("text");
                  if (pasted) {
                    e.preventDefault();
                    handlePasswordChange(pasted);
                  }
                }}
                className="input w-full text-xs font-mono h-9 pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-fg cursor-pointer"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Optional Advanced SMTP / IMAP Override */}
          <div className="rounded-lg border border-border bg-bgSubtle p-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-medium text-fg cursor-pointer"
            >
              <span>
                Advanced SMTP/IMAP ({smtpHost}:{smtpPort} · {imapHost}:{imapPort})
              </span>
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showAdvanced && (
              <div className="mt-3 pt-3 border-t border-border space-y-2.5">
                <div>
                  <label className="text-[11px] font-medium text-muted block mb-1">
                    Account Label (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="My Warm-up Gmail"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="input w-full text-xs h-8"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="text-[11px] font-medium text-muted block mb-1">
                      SMTP Host
                    </label>
                    <input
                      type="text"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      className="input w-full text-xs font-mono h-8"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted block mb-1">
                      SMTP Port
                    </label>
                    <input
                      type="number"
                      value={smtpPort}
                      onChange={(e) => {
                        const p = Number(e.target.value) || 587;
                        setSmtpPort(p);
                        setSmtpSecurity(p === 465 ? "ssl" : "starttls");
                      }}
                      className="input w-full text-xs font-mono h-8"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="text-[11px] font-medium text-muted block mb-1">
                      IMAP Host
                    </label>
                    <input
                      type="text"
                      value={imapHost}
                      onChange={(e) => setImapHost(e.target.value)}
                      className="input w-full text-xs font-mono h-8"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted block mb-1">
                      IMAP Port
                    </label>
                    <input
                      type="number"
                      value={imapPort}
                      onChange={(e) => {
                        const p = Number(e.target.value) || 993;
                        setImapPort(p);
                        setImapSecurity(p === 993 ? "ssl" : "tls");
                      }}
                      className="input w-full text-xs font-mono h-8"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Connection Test Output */}
          {testResult && (
            <div className="space-y-2 text-xs">
              <div
                className={`p-2.5 rounded-lg border flex items-start gap-2 ${
                  testResult.smtpOk
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300"
                }`}
              >
                {testResult.smtpOk ? (
                  <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-semibold">
                    {testResult.smtpOk ? "SMTP Verified (Sending Ready)" : "SMTP Failed"}
                  </div>
                  {!testResult.smtpOk && testResult.smtpMsg && (
                    <div className="text-[11px] mt-0.5">{testResult.smtpMsg}</div>
                  )}
                </div>
              </div>

              <div
                className={`p-2.5 rounded-lg border flex items-start gap-2 ${
                  testResult.imapOk
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300"
                }`}
              >
                {testResult.imapOk ? (
                  <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-semibold">
                    {testResult.imapOk
                      ? "IMAP Verified (Auto-Replies Ready)"
                      : "IMAP Not Verified"}
                  </div>
                  {!testResult.imapOk && testResult.imapMsg && (
                    <div className="text-[11px] mt-0.5">{testResult.imapMsg}</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={testing || !cleanEmail || !cleanPass}
              icon={<RefreshCw size={12} className={testing ? "animate-spin" : ""} />}
            >
              {testing ? "Testing..." : "Test SMTP & IMAP"}
            </Button>

            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={saving || !cleanEmail || !cleanPass}
                icon={saving ? <Loader2 size={12} className="animate-spin" /> : undefined}
              >
                {saving ? "Saving..." : "Save & Enable Warm-up"}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
