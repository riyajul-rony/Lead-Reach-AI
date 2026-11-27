"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Plus,
  CheckCircle2,
  AlertCircle,
  Mail,
  Server,
  Trash2,
  RefreshCw,
  Clock,
  Info,
  HelpCircle,
  ExternalLink,
  ShieldCheck,
  Pause,
  Play,
  Settings,
  Flame,
  Globe,
  Zap,
  AlertTriangle,
  Lock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SendingSpeedCard } from "@/components/outreach/sending-speed-card";
import { Switch } from "@/components/ui/switch";
import { InfoTooltip } from "@/components/outreach/info-tooltip";
import {
  getWarmupStatusPillLabel,
  getWarmupStateKey,
  getActiveAccountsWithWarmupOff,
  getReplyCapabilityInfo,
} from "@/lib/warmup-ui";
import {
  GmailAppPasswordGuide,
  stripAppPasswordSpaces,
} from "@/components/warmup/gmail-app-password-guide";

export interface EmailAccount {
  id: string;
  label: string;
  provider: "smtp" | "gmail_api";
  from_name?: string | null;
  senderName?: string | null;
  from_email: string;
  reply_to?: string | null;
  reply_inbox_account_id?: string | null;
  reply_inbox?: { id: string; label: string; from_email: string } | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_security?: string | null;
  smtp_username?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_security?: string | null;
  hourly_limit: number;
  daily_limit: number;
  effective_daily_limit?: number;
  remainingToday?: number;
  gap_seconds?: number;
  min_gap_seconds?: number;
  max_gap_seconds?: number;
  timezone?: string;
  warmup_enabled?: boolean;
  warmup_day?: number;
  warmup_start_limit?: number;
  warmup_daily_increment?: number;
  warmup_max_limit?: number;
  dns_spf_status?: string | null;
  dns_dkim_status?: string | null;
  dns_dmarc_status?: string | null;
  status: "active" | "paused" | "paused_deliverability" | "needs_attention" | "disabled" | string;
  last_error?: string | null;
  consecutive_smtp_auth_failures?: number;
  deliverability_pause_reason?: string | null;
  deliverability_paused_at?: string | null;
  sentLastHour?: number;
  sentToday?: number;
  warmupToday?: number;
  workspace_tier?: "trial" | "paid" | string | null;
  user_daily_limit?: number | null;
  admin_daily_limit_override?: number | null;
  adaptive_limit?: {
    accountType: "free_gmail" | "workspace_trial" | "workspace_paid";
    workspaceTier: "trial" | "paid" | null;
    ageTier: "under_30d" | "30_to_89d" | "90_to_364d" | "365d_plus";
    ageTierLabel: string;
    ageSource: "imap" | "fallback";
    ageVerificationFailed: boolean;
    detectedAgeDays: number | null;
    messageCount: number | null;
    detectedAt: string | null;
    hasWarmupBonus: boolean;
    startLimit: number;
    planCeiling: number;
    officialLimit: number;
    effectiveDailyLimit: number;
    baseAdaptiveLimit: number;
    usedToday: number;
    warmupToday: number;
    remainingToday: number;
    healthyWeeksCompleted: number;
    rampStartedAt: string | null;
    nextIncreaseDate: string | null;
    healthStatus: "healthy" | "holding" | "reduced" | "paused";
    userDailyLimit: number | null;
    adminDailyLimitOverride: number | null;
    rateLimitedUntil: string | null;
  } | null;
  has_smtp_password?: boolean;
  has_imap_password?: boolean;
  has_oauth_token?: boolean;
  has_reply_detection?: boolean;
  reply_detection_reason?: string;
}

/* ──── Provider presets: only prefill Host/Port/SSL ──── */
const PROVIDER_PRESETS = [
  {
    id: "gmail",
    name: "Gmail (App Password)",
    hint: "Uses smtp.gmail.com:587 (TLS) + imap.gmail.com:993 (SSL) · Spaces removed from App Password automatically",
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    ssl: false,
  },
  {
    id: "outlook",
    name: "Outlook / Microsoft 365",
    hint: "Enable Authenticated SMTP in M365 Admin Center",
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
    ssl: false,
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    hint: "For India accounts use smtp.zoho.in; for custom business domains use smtppro.zoho.com.",
    smtp_host: "smtp.zoho.com",
    smtp_port: 465,
    ssl: true,
  },
  {
    id: "custom",
    name: "Other (Custom)",
    hint: "Hostinger, Namecheap, cPanel, private VPS",
    smtp_host: "",
    smtp_port: 465,
    ssl: true,
  },
];

/* ──── Friendly error formatter ──── */
function formatFriendlyError(rawError?: string, host: string = ""): string {
  if (!rawError) return "Connection failed. Check host, port and credentials.";
  const lower = rawError.toLowerCase();
  const h = host.toLowerCase();

  const isAuth =
    lower.includes("eauth") ||
    lower.includes("535") ||
    lower.includes("username and password not accepted") ||
    lower.includes("authentication failed") ||
    lower.includes("invalid credentials") ||
    lower.includes("login failed") ||
    lower.includes("command failed") ||
    lower.includes("authenticationfailed");

  if (isAuth) {
    if (h.includes("zoho"))
      return "Zoho rejected credentials. Use an App-Specific Password (accounts.zoho.com > Security). Ensure IMAP is enabled in Zoho Mail Settings. Verify your region (.com/.in/.eu).";
    if (h.includes("office365") || h.includes("outlook"))
      return "Microsoft 365 rejected login. Enable 'Authenticated SMTP' in M365 Admin Center. Use an App Password if MFA is active.";
    if (h.includes("gmail") || h.includes("google"))
      return "Gmail rejected login. Generate a 16-character App Password at myaccount.google.com/apppasswords with 2-Step Verification ON.";
    return "Authentication failed. Check your email and password. If 2FA is on, use an app-specific password.";
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo"))
    return `Server "${host}" not found. Check the hostname.`;
  if (lower.includes("etimedout") || lower.includes("econnrefused"))
    return "Connection timed out or refused. Check port and firewall.";
  return rawError;
}

export function EmailAccountsManager({
  initialAccounts,
}: {
  initialAccounts: EmailAccount[];
}) {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<EmailAccount[]>(initialAccounts);
  const [loading, setLoading] = useState(false);

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isAppPasswordGuideOpen, setIsAppPasswordGuideOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);

  // ─── Simplified Add Form (n8n-style: 5 fields) ───
  const [selectedPreset, setSelectedPreset] = useState("gmail");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState(587);
  const [sslEnabled, setSslEnabled] = useState(false);

  // Connection test state
  const [modalTesting, setModalTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    smtpOk: boolean;
    smtpError?: string;
    imapOk: boolean;
    imapWarn?: string;
    testedHost: string;
    testedPort: number;
    testedUser: string;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Per-account live test & profile recheck state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [tierUpdatingId, setTierUpdatingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  // Deletion confirmation state
  const [accountToDelete, setAccountToDelete] = useState<{ id: string; email: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Self Warm-up Pool state
  const [warmupLogs, setWarmupLogs] = useState<any[]>([]);
  const [warmupSummary, setWarmupSummary] = useState<{
    poolCount: number;
    imapCapableCount: number;
    poolActive: boolean;
    sentToday: number;
    repliedToday: number;
  } | null>(null);
  const [loadingWarmup, setLoadingWarmup] = useState(true);
  const [warmupError, setWarmupError] = useState<string | null>(null);
  const [togglingWarmupId, setTogglingWarmupId] = useState<string | null>(null);
  const [enablingPoolWarmup, setEnablingPoolWarmup] = useState(false);

  const warmupStateKey = getWarmupStateKey(accounts);

  useEffect(() => {
    setLoadingWarmup(true);
    setWarmupError(null);
    fetch("/api/v1/email-accounts/warmup-logs?limit=10")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || "Failed to load warm-up logs");
        setWarmupLogs(json.data?.items || []);
        setWarmupSummary(json.data?.summary || null);
      })
      .catch((e: any) => setWarmupError(e?.message || "Failed to load warm-up logs"))
      .finally(() => setLoadingWarmup(false));
  }, [warmupStateKey]);

  // Banner notification from OAuth redirect
  const [bannerNotice, setBannerNotice] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (searchParams.get("connected") === "true") {
      setBannerNotice({
        type: "success",
        text: `Google Gmail sender account (${searchParams.get("email") || "Google Account"}) was successfully linked!`,
      });
    } else if (searchParams.get("reconnected") === "true") {
      setBannerNotice({
        type: "success",
        text: `Google account tokens refreshed and reconnected successfully!`,
      });
    } else if (searchParams.get("error")) {
      setBannerNotice({
        type: "error",
        text: `Authorization Error: ${decodeURIComponent(searchParams.get("error") || "")}`,
      });
    }
  }, [searchParams]);

  /* ──── Provider preset apply ──── */
  const handleApplyPreset = (presetId: string) => {
    setSelectedPreset(presetId);
    setTestResult(null);
    setFormError(null);
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setSmtpHost(preset.smtp_host);
    setSmtpPort(preset.smtp_port);
    setSslEnabled(preset.ssl);
  };

  /* ──── Fetch accounts ──── */
  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/email-accounts");
      const json = await res.json();
      if (json.data) setAccounts(json.data);
    } catch {} finally {
      setLoading(false);
    }
  };

  /* ──── Test existing account ──── */
  const handleTestExisting = async (accountId: string) => {
    setTestingId(accountId);
    try {
      const res = await fetch(`/api/v1/email-accounts/${accountId}`, {
        method: "POST",
      });
      const json = await res.json();
      if (json.data) {
        const ok = Boolean(json.data.allOk);
        const rawErr = json.data.smtp?.error || json.data.imap?.error || "Connection Failed";
        const account = accounts.find((acc) => acc.id === accountId);
        const msg = ok
          ? "Connection Active & Verified"
          : formatFriendlyError(rawErr, account?.smtp_host || account?.from_email || "");
        setTestResults((prev) => ({ ...prev, [accountId]: { ok, message: msg } }));
      }
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [accountId]: { ok: false, message: err.message || "Network test failed" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  /* ──── Re-check mailbox age & adaptive profile ──── */
  const handleRecheckProfile = async (
    accountId: string,
    workspaceTier?: "trial" | "paid"
  ) => {
    setRecheckingId(accountId);
    try {
      const res = await fetch(`/api/v1/email-accounts/${accountId}/recheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspaceTier ? { workspaceTier } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to re-check account profile");
      }
      await fetchAccounts();
      const warning = json.data?.warning;
      const adaptive = json.data?.adaptive_limit;
      setTestResults((prev) => ({
        ...prev,
        [accountId]: {
          ok: !warning,
          message: warning
            ? `Profile refreshed (${adaptive?.ageTierLabel || "< 30 days"} fallback). ${warning}`
            : `Profile verified: ${adaptive?.ageTierLabel || "verified"}, ${adaptive?.effectiveDailyLimit ?? "--"}/day limit`,
        },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [accountId]: {
          ok: false,
          message: err?.message || "Failed to re-check account profile",
        },
      }));
    } finally {
      setRecheckingId(null);
    }
  };

  /* ──── Update Workspace plan tier ──── */
  const handleWorkspaceTierChange = async (
    accountId: string,
    workspaceTier: "trial" | "paid"
  ) => {
    setTierUpdatingId(accountId);
    try {
      const res = await fetch(`/api/v1/email-accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_tier: workspaceTier }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to update Workspace tier");
      }
      await fetchAccounts();
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [accountId]: {
          ok: false,
          message: err?.message || "Failed to update Workspace tier",
        },
      }));
    } finally {
      setTierUpdatingId(null);
    }
  };

  /* ──── Toggle account status ──── */
  const handleToggleStatus = async (account: EmailAccount) => {
    const nextStatus = account.status === "active" ? "paused" : "active";
    try {
      const res = await fetch(`/api/v1/email-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        await fetchAccounts();
      }
    } catch {
      alert("Failed to toggle account status");
    }
  };

  /* ──── Toggle warm-up directly on an inbox row ──── */
  const handleToggleWarmup = async (account: EmailAccount) => {
    const nextEnabled = !account.warmup_enabled;
    setTogglingWarmupId(account.id);
    try {
      const res = await fetch(`/api/v1/email-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warmup_enabled: nextEnabled }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to toggle warm-up");
      }
      await fetchAccounts();
    } catch (err: any) {
      setBannerNotice({
        type: "error",
        text: err?.message || "Failed to toggle warm-up for inbox",
      });
    } finally {
      setTogglingWarmupId(null);
    }
  };

  /* ──── One-click Enable Warm-up on active inboxes ──── */
  const handleEnablePoolWarmup = async () => {
    const targets = accounts.filter((a) => a.status === "active" && !a.warmup_enabled);
    if (targets.length === 0) return;
    setEnablingPoolWarmup(true);
    try {
      await Promise.all(
        targets.map(async (acc) => {
          const res = await fetch(`/api/v1/email-accounts/${acc.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ warmup_enabled: true }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            throw new Error(json.error || `Failed to enable warm-up for ${acc.from_email}`);
          }
        })
      );
      await fetchAccounts();
      setBannerNotice({
        type: "success",
        text: `Warm-up enabled on ${targets.length} active inbox${targets.length > 1 ? "es" : ""}.`,
      });
    } catch (err: any) {
      setBannerNotice({
        type: "error",
        text: err?.message || "Failed to enable warm-up on active inboxes",
      });
    } finally {
      setEnablingPoolWarmup(false);
    }
  };

  /* ──── Manual resume for deliverability-paused accounts ──── */
  const handleManualResume = async (accountId: string) => {
    setTestingId(accountId);
    try {
      const res = await fetch(`/api/v1/email-accounts/${accountId}/resume`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to resume account");
      }
      await fetchAccounts();
      setTestResults((prev) => ({
        ...prev,
        [accountId]: { ok: true, message: "Inbox manually resumed cleanly." },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [accountId]: { ok: false, message: err?.message || "Failed to resume account" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  /* ──── Delete account ──── */
  const handleDeleteAccount = (accountId: string, emailAddr: string) => {
    setAccountToDelete({ id: accountId, email: emailAddr });
  };

  const confirmDeleteAccount = async () => {
    if (!accountToDelete) return;
    setDeletingId(accountToDelete.id);
    try {
      const res = await fetch(`/api/v1/email-accounts/${accountToDelete.id}`, { method: "DELETE" });
      if (res.ok) {
        setAccounts((prev) => prev.filter((a) => a.id !== accountToDelete.id));
      }
    } finally {
      setDeletingId(null);
      setAccountToDelete(null);
    }
  };

  /* ──── Modal: Test Connection (SMTP + auto-derived IMAP) ──── */
  const handleModalTestConnection = async () => {
    const trimmedEmail = email.trim();
    const trimmedHost = smtpHost.trim();
    const normalizedPassword =
      selectedPreset === "gmail" ? stripAppPasswordSpaces(password) : password;
    if (!trimmedEmail || !normalizedPassword || !trimmedHost) return;

    setModalTesting(true);
    setTestResult(null);
    setFormError(null);

    try {
      const res = await fetch("/api/v1/email-accounts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtp: {
            host: trimmedHost,
            port: smtpPort,
            security: sslEnabled ? "ssl" : "tls",
            username: trimmedEmail,
            password: normalizedPassword,
          },
          imap: {
            host: deriveImapHostClient(trimmedHost),
            port: 993,
            security: "ssl",
            username: trimmedEmail,
            password: normalizedPassword,
          },
        }),
      });
      const json = await res.json();
      if (json.data) {
        const smtpOk = Boolean(json.data.smtp?.ok);
        const imapOk = Boolean(json.data.imap?.ok);
        setTestResult({
          smtpOk,
          smtpError: smtpOk ? undefined : formatFriendlyError(json.data.smtp?.error, trimmedHost),
          imapOk,
          imapWarn: imapOk ? undefined : "⚠ Reply detection is off. You can fix it later.",
          testedHost: trimmedHost,
          testedPort: smtpPort,
          testedUser: trimmedEmail,
        });
      } else {
        setTestResult({
          smtpOk: false,
          smtpError: formatFriendlyError(json.error, trimmedHost),
          imapOk: false,
          testedHost: trimmedHost,
          testedPort: smtpPort,
          testedUser: trimmedEmail,
        });
      }
    } catch (err: any) {
      setTestResult({
        smtpOk: false,
        smtpError: err.message || "Network error",
        imapOk: false,
        testedHost: trimmedHost,
        testedPort: smtpPort,
        testedUser: trimmedEmail,
      });
    } finally {
      setModalTesting(false);
    }
  };

  /* ──── Client-side IMAP host derivation (mirrors server logic) ──── */
  function deriveImapHostClient(host: string): string {
    const h = host.trim().toLowerCase();
    if (h.startsWith("smtppro.")) return h.replace(/^smtppro\./, "imappro.");
    if (h.startsWith("smtp.")) return h.replace(/^smtp\./, "imap.");
    return h;
  }

  /* ──── Modal: Save Account ──── */
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedHost = smtpHost.trim();
    const normalizedPassword =
      selectedPreset === "gmail" ? stripAppPasswordSpaces(password) : password;
    if (!trimmedEmail || !normalizedPassword || !trimmedHost) {
      setFormError("Email, password, and SMTP host are required.");
      return;
    }
    setSaving(true);
    setFormError(null);

    try {
      const smtpSecurity = sslEnabled ? "ssl" : "tls";
      const imapHost = deriveImapHostClient(trimmedHost);
      const res = await fetch("/api/v1/email-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_email: trimmedEmail,
          smtp_host: trimmedHost,
          smtp_port: smtpPort,
          smtp_security: smtpSecurity,
          smtp_password: normalizedPassword,
          // Everything else: server applies Safe Preset defaults + auto-derives IMAP
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        let targetId = json.existingAccountId as string | undefined;
        if (!targetId) {
          const found = accounts.find(
            (a) => a.from_email?.toLowerCase().trim() === trimmedEmail.toLowerCase()
          );
          targetId = found?.id;
        }
        if (!targetId) {
          throw new Error(json.error || "This email account is already connected.");
        }

        const patchRes = await fetch(`/api/v1/email-accounts/${targetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "smtp",
            smtp_host: trimmedHost,
            smtp_port: smtpPort,
            smtp_security: smtpSecurity,
            smtp_username: trimmedEmail,
            smtp_password: normalizedPassword,
            imap_host: imapHost,
            imap_port: 993,
            imap_security: "ssl",
            imap_username: trimmedEmail,
            imap_password: normalizedPassword,
            warmup_enabled: true,
            status: "active",
          }),
        });
        const patchJson = await patchRes.json().catch(() => ({}));
        if (!patchRes.ok) {
          throw new Error(patchJson.error || "Could not update existing email account.");
        }
      } else if (!res.ok) {
        throw new Error(json.error || "Failed to register inbox");
      }

      setIsAddModalOpen(false);
      resetForm();
      await fetchAccounts();
    } catch (err: any) {
      setFormError(err.message || "Failed to save email account");
    } finally {
      setSaving(false);
    }
  };

  /* ──── Edit account settings (post-save drawer) ──── */
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/email-accounts/${editingAccount.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: editingAccount.label,
          from_name: editingAccount.senderName ?? editingAccount.from_name ?? "",
          senderName: editingAccount.senderName ?? editingAccount.from_name ?? "",
          reply_to: editingAccount.reply_to || null,
          reply_inbox_account_id: editingAccount.reply_inbox_account_id || null,
          signature: editingAccount.signature || undefined,
          hourly_limit: editingAccount.hourly_limit,
          daily_limit: editingAccount.daily_limit,
          user_daily_limit:
            editingAccount.user_daily_limit === undefined
              ? null
              : editingAccount.user_daily_limit,
          gap_seconds: editingAccount.min_gap_seconds || editingAccount.gap_seconds || 180,
          min_gap_seconds: editingAccount.min_gap_seconds || editingAccount.gap_seconds || 180,
          max_gap_seconds: editingAccount.max_gap_seconds || 420,
          timezone: editingAccount.timezone,
          warmup_enabled: editingAccount.warmup_enabled,
          warmup_day: editingAccount.warmup_day,
          warmup_start_limit: editingAccount.warmup_start_limit,
          warmup_daily_increment: editingAccount.warmup_daily_increment,
          warmup_max_limit: editingAccount.warmup_max_limit,
        }),
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Failed to update settings");
      }

      setEditingAccount(null);
      await fetchAccounts();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    handleApplyPreset("gmail");
    setEmail("");
    setPassword("");
    setTestResult(null);
    setFormError(null);
  };

  const totalHourlyCap = accounts.reduce((acc, a) => acc + (a.hourly_limit || 25), 0);
  const totalDailyCap = accounts.reduce(
    (acc, a) => acc + (a.effective_daily_limit || a.daily_limit || 150),
    0
  );

  return (
    <div className="space-y-6">
      {/* Top Banner Alert (if returning from Google OAuth or error) */}
      {bannerNotice && (
        <div
          className={`p-4 rounded-xl border flex items-center justify-between text-xs ${
            bannerNotice.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400"
          }`}
        >
          <div className="flex items-center gap-2">
            {bannerNotice.type === "success" ? (
              <CheckCircle2 size={16} />
            ) : (
              <AlertCircle size={16} />
            )}
            <span className="font-medium">{bannerNotice.text}</span>
          </div>
          <button
            onClick={() => setBannerNotice(null)}
            className="text-xs hover:underline cursor-pointer ml-4 font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header and Add Buttons */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted mb-1">
            <Link href="/app/outreach" className="hover:text-fg transition-colors flex items-center gap-1">
              <ArrowLeft size={13} /> Outreach Campaigns
            </Link>
            <span>/</span>
            <span className="text-fg font-medium">Sender Accounts</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-fg flex items-center gap-2">
            Sender Inboxes &amp; Email Accounts
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-muted">
            Connect personal or business email accounts via Google OAuth or SMTP/IMAP with warm-up schedules and 25/hr protection.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Option 1: Direct Google Login OAuth Button */}
          <a
            href="/api/v1/auth/google/outreach/start"
            className="btn btn-secondary text-xs h-9 px-3 flex items-center gap-2"
            title="Connect Google Account directly via OAuth"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            Connect with Google
          </a>

          {/* Option 2: Add SMTP/IMAP Account Button */}
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              resetForm();
              setIsAddModalOpen(true);
            }}
            icon={<Plus size={14} />}
          >
            Add SMTP / IMAP
          </Button>
        </div>
      </div>

      {/* Metrics Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-surface p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-bgSubtle border border-border text-fg">
            <Mail size={18} />
          </div>
          <div>
            <div className="text-lg font-bold text-fg">{accounts.length}</div>
            <div className="text-[11px] text-muted">Connected Inboxes</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-bgSubtle border border-border text-fg">
            <ShieldCheck size={18} />
          </div>
          <div>
            <div className="text-lg font-bold text-fg">
              {totalHourlyCap}<span className="text-muted text-xs font-normal">/hr</span>
            </div>
            <div className="text-[11px] text-muted">Total Hourly Cap</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-bgSubtle border border-border text-fg">
            <Zap size={18} />
          </div>
          <div>
            <div className="text-lg font-bold text-fg">
              {totalDailyCap}<span className="text-muted text-xs font-normal">/day</span>
            </div>
            <div className="text-[11px] text-muted">Total Daily Volume</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-bgSubtle border border-border text-fg">
            <Clock size={18} />
          </div>
          <div>
            <div className="text-lg font-bold text-fg">
              {accounts.reduce((t, a) => t + (a.sentToday || 0), 0)}
            </div>
            <div className="text-[11px] text-muted">Sent Today</div>
          </div>
        </div>
      </div>

      {/* Private Self Warm-up Pool Card */}
      <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Flame size={16} />
            </div>
            <div>
              <div className="text-sm font-semibold text-fg flex items-center gap-2">
                <span>Self Warm-up Pool (Private)</span>
                <Badge
                  variant={
                    (warmupSummary?.poolCount ?? accounts.filter((a) => a.status === "active" && a.warmup_enabled).length) >= 2
                      ? "success"
                      : "warning"
                  }
                  size="sm"
                >
                  {(warmupSummary?.poolCount ?? accounts.filter((a) => a.status === "active" && a.warmup_enabled).length) >= 2
                    ? "Pool Active"
                    : "Need 2+ Warm-up Inboxes"}
                </Badge>
              </div>
              <p className="text-[11px] text-muted mt-0.5">
                Private warm-up rotates messages only between your own connected active accounts with Warm-up ON (minimum 2 required). Automated replies require IMAP on the receiving inbox. This does not send to external third-party warm-up networks.
              </p>
            </div>
          </div>
          {warmupSummary && (
            <div className="flex items-center gap-3 text-[11px] text-muted shrink-0 font-mono flex-wrap">
              <span>Pool: {warmupSummary.poolCount} inboxes ({warmupSummary.imapCapableCount} IMAP)</span>
              <span>Today: {warmupSummary.sentToday} sent · {warmupSummary.repliedToday} replied</span>
              <Link
                href="/app/warmup"
                className="font-sans text-primary hover:underline font-semibold"
              >
                Open Warm-up Dashboard &rarr;
              </Link>
            </div>
          )}
        </div>

        {loadingWarmup ? (
          <div className="text-[11px] text-muted py-1">Loading recent warm-up pool activity...</div>
        ) : warmupError ? (
          <div className="text-[11px] text-rose-600 dark:text-rose-400">{warmupError}</div>
        ) : warmupLogs.length === 0 ? (
          <div className="text-[11px] text-muted border border-dashed border-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span>
              {(warmupSummary?.poolCount ?? accounts.filter((a) => a.status === "active" && a.warmup_enabled).length) < 2
                ? "Enable Warm-up on at least 2 active inboxes to start internal warm-up rotations."
                : "No self warm-up activity yet. Your pool is ready and will rotate on the next worker tick."}
            </span>
            {(warmupSummary?.poolCount ?? accounts.filter((a) => a.status === "active" && a.warmup_enabled).length) < 2 &&
              getActiveAccountsWithWarmupOff(accounts).length > 0 && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={enablingPoolWarmup}
                  onClick={handleEnablePoolWarmup}
                  icon={<Flame size={13} />}
                  className="shrink-0"
                >
                  {enablingPoolWarmup
                    ? "Enabling..."
                    : `Enable Warm-up (${getActiveAccountsWithWarmupOff(accounts).length} Active)`}
                </Button>
              )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="border-b border-border text-muted uppercase">
                  <th className="py-1.5 pr-3">From</th>
                  <th className="py-1.5 pr-3">To</th>
                  <th className="py-1.5 pr-3">Subject</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {warmupLogs.slice(0, 5).map((wl) => (
                  <tr key={wl.id}>
                    <td className="py-1.5 pr-3 font-mono text-fg">{wl.from_account?.from_email || wl.from_account_id}</td>
                    <td className="py-1.5 pr-3 font-mono text-muted">{wl.to_account?.from_email || wl.to_account_id}</td>
                    <td className="py-1.5 pr-3 text-fg truncate max-w-[200px]">{wl.subject}</td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={wl.status === "replied" ? "success" : wl.status === "failed" ? "danger" : "neutral"} size="sm">
                        {wl.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-muted whitespace-nowrap">
                      {wl.sent_at ? new Date(wl.sent_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Account List */}
      {accounts.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <Mail size={32} className="mx-auto mb-3 text-muted" />
          <h3 className="text-sm font-bold text-fg mb-1">No Sender Inboxes Connected</h3>
          <p className="text-xs text-muted mb-4">
            Add your first email account to begin sending cold outreach campaigns.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              resetForm();
              setIsAddModalOpen(true);
            }}
            icon={<Plus size={14} />}
          >
            Connect Your First Inbox
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => {
            const isOAuth = account.provider === "gmail_api";
            const testResult = testResults[account.id];
            const isActive = account.status === "active";
            const effectiveLimit = account.effective_daily_limit || account.daily_limit;
            const minGap = account.min_gap_seconds || account.gap_seconds || 180;
            const maxGap = account.max_gap_seconds || 420;
            const hasDirectImap = Boolean(account.imap_host && account.has_imap_password);
            const hasReplyInbox = Boolean(account.reply_inbox_account_id || account.reply_inbox);
            const hasWorkingReply = account.has_reply_detection ?? (hasDirectImap || hasReplyInbox);

            return (
              <div
                key={account.id}
                className={`rounded-xl border bg-surface p-4 transition-all ${
                  isActive ? "border-border" : "border-amber-500/30 bg-amber-500/5"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`grid h-10 w-10 place-items-center rounded-lg shrink-0 ${
                        isOAuth
                          ? "bg-blue-500/10 text-blue-500"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      <Mail size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-fg truncate">{account.from_email}</span>
                        <Badge variant={isOAuth ? "accent" : "neutral"} size="sm">
                          {isOAuth ? "Google OAuth" : "SMTP"}
                        </Badge>
                        <Badge
                          variant={
                            isActive
                              ? "success"
                              : account.status === "paused_deliverability"
                                ? "danger"
                                : "warning"
                          }
                          size="sm"
                        >
                          {isActive
                            ? "Active"
                            : account.status === "paused_deliverability"
                              ? "Paused (Deliverability)"
                              : account.status}
                        </Badge>
                        {(() => {
                          const replyCap = getReplyCapabilityInfo({
                            ...account,
                            has_reply_detection: hasWorkingReply,
                          });
                          return (
                            <span className="inline-flex items-center gap-1">
                              <Badge variant={replyCap.capable ? "success" : "warning"} size="sm">
                                {replyCap.badgeLabel}
                              </Badge>
                              <InfoTooltip
                                title={replyCap.tooltipTitle}
                                content={replyCap.tooltipContent}
                              />
                            </span>
                          );
                        })()}
                        {!hasDirectImap && hasReplyInbox && (
                          <Badge variant="neutral" size="sm">
                            Reply via: {account.reply_inbox?.from_email || "Linked Inbox"}
                          </Badge>
                        )}
                        <Badge variant={account.warmup_enabled ? "warning" : "neutral"} size="sm">
                          <Flame size={10} className="mr-0.5" /> {getWarmupStatusPillLabel(account)}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted flex items-center gap-3 mt-0.5 flex-wrap">
                        <span>{account.label || "Inbox"}</span>
                        {account.from_name && <span>· {account.from_name}</span>}
                        <span>· {account.adaptive_limit?.effectiveDailyLimit ?? effectiveLimit}/day</span>
                        <span>
                          · {Math.round(minGap / 60)}–{Math.round(maxGap / 60)} min gap
                        </span>
                        {account.adaptive_limit ? (
                          <span>
                            · Used today: {account.adaptive_limit.usedToday}/{account.adaptive_limit.effectiveDailyLimit}
                          </span>
                        ) : (
                          account.sentToday !== undefined && (
                            <span>
                              · Sent today: {account.sentToday}/{effectiveLimit}
                            </span>
                          )
                        )}
                      </div>

                      {account.adaptive_limit && (() => {
                        const al = account.adaptive_limit;
                        const accountTypeLabel =
                          al.accountType === "free_gmail"
                            ? "Free Gmail"
                            : al.accountType === "workspace_paid"
                              ? "Workspace Paid"
                              : "Workspace Trial";
                        const healthBadgeVariant =
                          al.healthStatus === "healthy"
                            ? "success"
                            : al.healthStatus === "paused"
                              ? "danger"
                              : "warning";
                        const healthLabel =
                          al.healthStatus === "healthy"
                            ? "Healthy"
                            : al.healthStatus === "holding"
                              ? "Holding"
                              : al.healthStatus === "reduced"
                                ? "Reduced"
                                : "Paused";
                        const nextIncreaseText =
                          al.baseAdaptiveLimit >= al.planCeiling
                            ? "At ceiling"
                            : al.nextIncreaseDate
                              ? new Date(al.nextIncreaseDate).toLocaleDateString()
                              : "After first 7 healthy days";

                        return (
                          <div className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-2 text-[11px]">
                            <Badge variant="neutral" size="sm">
                              {accountTypeLabel}
                            </Badge>
                            {al.accountType !== "free_gmail" && (
                              <select
                                aria-label="Google Workspace plan tier"
                                disabled={tierUpdatingId === account.id}
                                value={al.workspaceTier === "paid" ? "paid" : "trial"}
                                onChange={(e) =>
                                  handleWorkspaceTierChange(
                                    account.id,
                                    e.target.value === "paid" ? "paid" : "trial"
                                  )
                                }
                                className="input h-6 text-[11px] py-0 px-2 w-auto"
                              >
                                <option value="trial">Workspace trial or not sure</option>
                                <option value="paid">Paid Workspace</option>
                              </select>
                            )}
                            <Badge variant={al.ageVerificationFailed ? "warning" : "neutral"} size="sm">
                              Age: {al.ageTierLabel} ({al.ageVerificationFailed ? "Could not verify account age" : "IMAP verified"})
                            </Badge>
                            <Badge variant={healthBadgeVariant as any} size="sm">
                              Health: {healthLabel}
                            </Badge>
                            <span className="text-muted">
                              Ceiling: <strong className="text-fg">{al.planCeiling}/day</strong>
                            </span>
                            <span className="text-muted">
                              Next increase: <strong className="text-fg">{nextIncreaseText}</strong>
                            </span>
                            {al.userDailyLimit !== null && (
                              <span className="text-muted">
                                · User cap: <strong className="text-fg">{al.userDailyLimit}/day</strong>
                              </span>
                            )}
                            {al.adminDailyLimitOverride !== null && (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">
                                · Admin override: {al.adminDailyLimitOverride}/day
                              </span>
                            )}
                            {al.rateLimitedUntil && (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">
                                · Provider throttle until {new Date(al.rateLimitedUntil).toLocaleString()}
                              </span>
                            )}
                            <InfoTooltip
                              title="Adaptive Sending Ramp"
                              content={`Adaptive ramp starts at ${al.startLimit}/day based on account age (${al.ageTierLabel})${al.hasWarmupBonus ? " +10 warm-up bonus" : ""}, grows +10/week after 7 healthy days up to ${al.planCeiling}/day (${al.accountType === "free_gmail" ? "Gmail" : "Workspace"}). Official provider cap: ${al.officialLimit}/day.`}
                            />
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    <div
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-bgSubtle"
                      title={
                        account.warmup_enabled
                          ? "Warm-up is ON for this inbox"
                          : "Warm-up is OFF — toggle on to join the Self Warm-up Pool"
                      }
                    >
                      <span className="text-[11px] font-medium text-muted">Warm-up</span>
                      <Switch
                        checked={Boolean(account.warmup_enabled)}
                        disabled={togglingWarmupId === account.id}
                        onChange={() => handleToggleWarmup(account)}
                        aria-label={`Toggle warm-up for ${account.from_email}`}
                      />
                    </div>
                    <button
                      onClick={() => handleTestExisting(account.id)}
                      disabled={testingId === account.id}
                      className="btn btn-secondary text-[11px] px-2 py-1.5 cursor-pointer flex items-center gap-1"
                      title="Test live connection"
                    >
                      <RefreshCw
                        size={11}
                        className={testingId === account.id ? "animate-spin" : ""}
                      />
                      Test
                    </button>
                    <button
                      onClick={() => handleRecheckProfile(account.id)}
                      disabled={recheckingId === account.id}
                      className="btn btn-secondary text-[11px] px-2 py-1.5 cursor-pointer flex items-center gap-1"
                      title="Re-check account age & DNS/IMAP profile"
                    >
                      <ShieldCheck
                        size={11}
                        className={recheckingId === account.id ? "animate-pulse" : ""}
                      />
                      {recheckingId === account.id ? "Checking..." : "Re-check"}
                    </button>
                    <button
                      onClick={() => handleToggleStatus(account)}
                      className="btn btn-secondary text-[11px] px-2 py-1.5 cursor-pointer flex items-center gap-1"
                      title={isActive ? "Pause inbox" : "Resume inbox"}
                    >
                      {isActive ? <Pause size={11} /> : <Play size={11} />}
                      {isActive ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => setEditingAccount(account)}
                      className="btn btn-secondary text-[11px] px-2 py-1.5 cursor-pointer flex items-center gap-1"
                      title="Account Settings"
                    >
                      <Settings size={11} />
                    </button>
                    <button
                      onClick={() => handleDeleteAccount(account.id, account.from_email)}
                      className="btn btn-secondary text-[11px] px-2 py-1.5 cursor-pointer text-rose-500 hover:text-rose-600"
                      title="Remove inbox"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                {/* Deliverability Auto-Pause Banner */}
                {account.status === "paused_deliverability" && (
                  <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div className="flex items-start gap-2 text-rose-700 dark:text-rose-300">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5 text-rose-500" />
                      <div>
                        <span className="font-semibold block">
                          Sending paused automatically due to deliverability signal
                        </span>
                        <span className="text-[11px] opacity-90">
                          {account.deliverability_pause_reason ||
                            account.last_error ||
                            "This mailbox exceeded safety thresholds and requires manual review before resuming."}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleManualResume(account.id)}
                      disabled={testingId === account.id}
                      className="btn btn-primary text-[11px] px-3 py-1.5 shrink-0 cursor-pointer"
                    >
                      {testingId === account.id ? "Resuming..." : "Manually Resume"}
                    </button>
                  </div>
                )}

                {/* Test Result Banner */}
                {testResult && (
                  <div
                    className={`mt-2 p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                      testResult.ok
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                    }`}
                  >
                    {testResult.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                    <span>{testResult.message}</span>
                  </div>
                )}

                {/* Reply Detection Notice */}
                {!hasWorkingReply && (
                  <div className="mt-2.5 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                    <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      {account.reply_detection_reason ||
                        "For follow-ups and stop-on-reply, connect with App Password + IMAP"}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Safety Engine Notice */}
      <div className="p-4 rounded-xl border border-border bg-surface text-xs text-muted space-y-1.5 flex items-start gap-3">
        <ShieldCheck size={18} className="text-primary mt-0.5 shrink-0" />
        <div>
          <span className="font-semibold text-fg">Cold Outreach Safety Engine:</span> Lead Reach AI strictly enforces a hard limit of <strong>25 emails per hour</strong> per inbox, randomized jitter gaps, and automated multi-inbox rotation.
          <div>
            Need help configuring Gmail?{" "}
            <button
              onClick={() => setIsAppPasswordGuideOpen(true)}
              className="text-fg font-semibold underline hover:text-primary cursor-pointer inline-flex items-center gap-1"
            >
              <HelpCircle size={12} /> View Step-by-Step Gmail App Password Guide
            </button>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          Modal: Add SMTP Account — n8n-style simplified (5 fields)
         ═══════════════════════════════════════════════════════════ */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-surface rounded-xl border border-border w-full max-w-lg max-h-[92vh] overflow-y-auto p-6 shadow-2xl relative space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div>
                <h3 className="text-base font-bold text-fg flex items-center gap-2">
                  <Mail size={16} /> Connect Email Account
                </h3>
                <p className="text-[11px] text-muted mt-0.5">
                  Encrypted with AES-256-GCM · Safe Preset defaults applied automatically
                </p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-muted hover:text-fg text-sm font-semibold p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Provider Selector */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-fg block">Email Provider</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PROVIDER_PRESETS.map((p) => {
                  const isSelected = selectedPreset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleApplyPreset(p.id)}
                      className={`p-2.5 rounded-lg border text-center transition-all cursor-pointer ${
                        isSelected
                          ? "border-primary bg-primary/5 shadow-xs"
                          : "border-border bg-surface hover:border-border/80"
                      }`}
                    >
                      <div className="text-xs font-bold text-fg">{p.name}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Gmail 1-Click OAuth Banner */}
            {selectedPreset === "gmail" && (
              <div className="p-3.5 rounded-xl border border-primary/30 bg-primary/5 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-fg flex items-center gap-1.5">
                    <Zap size={13} className="text-primary" />
                    Recommended: 1-Click Google OAuth
                  </div>
                  <p className="text-[11px] text-muted">
                    No password needed. Connect directly.
                  </p>
                </div>
                <a
                  href="/api/v1/auth/google/outreach/start?returnTo=/app/outreach?tab=accounts"
                  className="btn btn-primary text-xs px-3 py-2 shrink-0 flex items-center gap-1.5 font-semibold"
                >
                  <Zap size={12} /> Sign in with Google
                </a>
              </div>
            )}

            <form onSubmit={handleSaveAccount} className="space-y-4">
              {/* Field 1: Email */}
              <div>
                <label className="text-xs font-semibold text-fg block mb-1">
                  Email Address <span className="text-danger">*</span>
                </label>
                <input
                  type="email"
                  required
                  placeholder="you@yourdomain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input w-full text-xs font-mono h-9"
                />
                <p className="text-[10px] text-muted mt-0.5">
                  This is your sender address and SMTP login username.
                </p>
              </div>

              {/* Field 2: Password */}
              <div>
                <label className="text-xs font-semibold text-fg block mb-1">
                  {selectedPreset === "gmail"
                    ? "App Password (16-char)"
                    : selectedPreset === "zoho"
                    ? "App-Specific Password"
                    : selectedPreset === "outlook"
                    ? "Password / App Password"
                    : "Password"}{" "}
                  <span className="text-danger">*</span>
                </label>
                <input
                  type="password"
                  required
                  placeholder={
                    selectedPreset === "gmail"
                      ? "abcd efgh ijkl mnop"
                      : "Enter password"
                  }
                  value={password}
                  onChange={(e) =>
                    setPassword(
                      selectedPreset === "gmail"
                        ? stripAppPasswordSpaces(e.target.value)
                        : e.target.value
                    )
                  }
                  onPaste={(e) => {
                    if (selectedPreset === "gmail") {
                      const pasted = e.clipboardData.getData("text");
                      if (pasted) {
                        e.preventDefault();
                        setPassword(stripAppPasswordSpaces(pasted));
                      }
                    }
                  }}
                  className="input w-full text-xs font-mono h-9"
                />
              </div>

              {selectedPreset === "gmail" && (
                <GmailAppPasswordGuide compact />
              )}

              {/* Fields 3-5: Host, Port, SSL — always visible and editable */}
              <div className="grid grid-cols-6 gap-3">
                <div className="col-span-3">
                  <label className="text-xs font-semibold text-fg block mb-1">
                    SMTP Host <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="smtp.example.com"
                    value={smtpHost}
                    onChange={(e) => {
                      setSmtpHost(e.target.value);
                      setTestResult(null);
                    }}
                    className="input w-full text-xs font-mono h-9"
                  />
                </div>
                <div className="col-span-1">
                  <label className="text-xs font-semibold text-fg block mb-1">Port</label>
                  <input
                    type="number"
                    required
                    value={smtpPort}
                    onChange={(e) => {
                      const p = Number(e.target.value);
                      setSmtpPort(p);
                      if (p === 465) setSslEnabled(true);
                      if (p === 587) setSslEnabled(false);
                    }}
                    className="input w-full text-xs font-mono h-9"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-fg block mb-1">Security</label>
                  <button
                    type="button"
                    onClick={() => setSslEnabled(!sslEnabled)}
                    className={`w-full h-9 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                      sslEnabled
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                        : "bg-surface border-border text-muted"
                    }`}
                  >
                    <Lock size={12} />
                    {sslEnabled ? "SSL (Port 465)" : "TLS (Port 587)"}
                  </button>
                </div>
              </div>

              {/* Provider-specific hint — always visible */}
              {selectedPreset !== "custom" && (
                <p className="text-[10px] text-muted leading-relaxed -mt-1">
                  {PROVIDER_PRESETS.find((p) => p.id === selectedPreset)?.hint}
                </p>
              )}

              {/* Connection Test Result */}
              {testResult && (
                <div className="space-y-2">
                  {/* SMTP Result */}
                  <div
                    className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                      testResult.smtpOk
                        ? "bg-emerald-500/10 border-emerald-500/30"
                        : "bg-rose-500/10 border-rose-500/30"
                    }`}
                  >
                    {testResult.smtpOk ? (
                      <CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle size={14} className="text-rose-500 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className={`font-semibold ${
                        testResult.smtpOk
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                      }`}>
                        {testResult.smtpOk ? "✓ Sending works" : "✗ Sending failed"}
                      </div>
                      {!testResult.smtpOk && testResult.smtpError && (
                        <div className="text-muted mt-1 leading-relaxed">{testResult.smtpError}</div>
                      )}
                      {!testResult.smtpOk && (
                        <div className="text-[10px] text-muted/70 mt-1 font-mono">
                          Tried: {testResult.testedHost}:{testResult.testedPort} · User: {testResult.testedUser}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* IMAP Result — shown when SMTP passed but IMAP failed (e.g. Zoho Free) */}
                  {testResult.smtpOk && !testResult.imapOk && (
                    <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs space-y-2 text-amber-900 dark:text-amber-200">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-amber-800 dark:text-amber-300">
                            Your mail provider plan may not include IMAP (for example Zoho Free). Sending works, but replies and bounces can&apos;t be detected from this account.
                          </div>
                        </div>
                      </div>

                      <div className="pl-6 pt-1 text-[11px] space-y-1.5 border-t border-amber-500/20 text-muted">
                        <div className="font-medium text-fg">Three ways to resolve this:</div>
                        <div className="flex items-start gap-1.5">
                          <span className="font-bold text-amber-600 dark:text-amber-400">1.</span>
                          <span><strong>Provider Paid Plan:</strong> Upgrade your provider plan (e.g. Zoho Mail Lite / Workplace) to enable IMAP access.</span>
                        </div>
                        <div className="flex items-start gap-1.5">
                          <span className="font-bold text-amber-600 dark:text-amber-400">2.</span>
                          <span><strong>Separate Reply Inbox:</strong> After saving, open Account Settings and select a connected Gmail or other inbox as the &quot;Reply Inbox&quot;.</span>
                        </div>
                        <div className="flex items-start gap-1.5">
                          <span className="font-bold text-amber-600 dark:text-amber-400">3.</span>
                          <span><strong>Send via Gmail:</strong> Connect via 1-Click Google OAuth or Gmail App Password for full sending &amp; reply detection.</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Form Error */}
              {formError && !testResult && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
                  <AlertCircle size={14} className="shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-3 border-t border-border">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleModalTestConnection}
                  disabled={modalTesting || !smtpHost.trim() || !email.trim() || !password}
                  icon={<RefreshCw size={12} className={modalTesting ? "animate-spin" : ""} />}
                >
                  {modalTesting ? "Testing..." : "Test Connection"}
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsAddModalOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={saving || !email.trim() || !password || !smtpHost.trim()}
                  >
                    {saving ? "Saving..." : "Save Inbox"}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════
          Modal: Edit Account Settings (post-save drawer)
         ═══════════════════════════════════════════════════ */}
      {editingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-surface rounded-xl border border-border w-full max-w-lg max-h-[92vh] overflow-y-auto p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-base font-bold text-fg flex items-center gap-2">
                <Settings size={16} /> Account Settings
              </h3>
              <button
                onClick={() => setEditingAccount(null)}
                className="text-muted hover:text-fg text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-fg block mb-1">Account Label</label>
                <input
                  type="text"
                  value={editingAccount.label}
                  onChange={(e) =>
                    setEditingAccount({ ...editingAccount, label: e.target.value })
                  }
                  className="input w-full text-xs h-9"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-fg block mb-1">
                  Sender Name (From Header)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Alex Carter"
                  value={editingAccount.senderName ?? editingAccount.from_name ?? ""}
                  onChange={(e) =>
                    setEditingAccount({
                      ...editingAccount,
                      from_name: e.target.value,
                      senderName: e.target.value,
                    })
                  }
                  className="input w-full text-xs h-9"
                />
                <p className="text-[10px] text-muted mt-1">
                  Use a real human name that matches the signature, not a product name. Available via{" "}
                  <code className="font-mono">{"{{sender_first_name}}"}</code>.
                </p>
              </div>

              {/* Reply-To Address and Reply Inbox */}
              <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-3">
                <div>
                  <label className="text-xs font-semibold text-fg block mb-1">
                    Reply-To Address (Optional)
                  </label>
                  <input
                    type="email"
                    placeholder="e.g. replies@yourdomain.com or Gmail"
                    value={editingAccount.reply_to || ""}
                    onChange={(e) =>
                      setEditingAccount({ ...editingAccount, reply_to: e.target.value })
                    }
                    className="input w-full text-xs h-9 font-mono"
                  />
                  <p className="text-[10px] text-muted mt-0.5">
                    Replies to your emails will be routed to this address.
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-fg block mb-1">
                    Reply Inbox (for automatic reply detection &amp; stop-on-reply)
                  </label>
                  <select
                    value={editingAccount.reply_inbox_account_id || ""}
                    onChange={(e) => {
                      const selectedId = e.target.value || null;
                      const linked = accounts.find((a) => a.id === selectedId);
                      setEditingAccount({
                        ...editingAccount,
                        reply_inbox_account_id: selectedId,
                        reply_to: editingAccount.reply_to || (linked ? linked.from_email : editingAccount.reply_to),
                      });
                    }}
                    className="input w-full text-xs h-9"
                  >
                    <option value="">-- No separate reply inbox (use account&apos;s own IMAP) --</option>
                    {accounts
                      .filter((a) => a.id !== editingAccount.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label || a.from_email} ({a.from_email}) {a.provider === "gmail_api" ? "· Google OAuth" : "· IMAP"}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-muted mt-0.5">
                    Lead Reach AI monitors this connected inbox to automatically detect prospect replies and stop follow-ups.
                  </p>
                </div>
              </div>

              {/* Sending Speed Card in Edit Settings Modal */}
              <SendingSpeedCard
                dailyLimit={editingAccount.daily_limit || 75}
                minWaitMinutes={Number((((editingAccount.min_gap_seconds || editingAccount.gap_seconds || 180)) / 60).toFixed(1))}
                maxWaitMinutes={Number((((editingAccount.max_gap_seconds || 420)) / 60).toFixed(1))}
                onChange={(vals) => {
                  setEditingAccount({
                    ...editingAccount,
                    daily_limit: vals.dailyLimit,
                    min_gap_seconds: Math.round(vals.minWaitMinutes * 60),
                    max_gap_seconds: Math.round(vals.maxWaitMinutes * 60),
                    gap_seconds: Math.round(vals.minWaitMinutes * 60),
                  });
                }}
              />

              {/* Optional user lower daily cap */}
              <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-fg">
                    Custom Daily Limit Cap (Optional, lower only)
                  </label>
                  {editingAccount.adaptive_limit && (
                    <span className="text-[11px] text-muted font-mono">
                      Adaptive max: {editingAccount.adaptive_limit.planCeiling}/day
                    </span>
                  )}
                </div>
                <input
                  type="number"
                  min={5}
                  placeholder="Leave blank to use automatic adaptive limit"
                  value={editingAccount.user_daily_limit ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    setEditingAccount({
                      ...editingAccount,
                      user_daily_limit: raw === "" ? null : Math.max(5, Number(raw) || 5),
                    });
                  }}
                  className="input w-full text-xs h-9"
                />
                <p className="text-[10px] text-muted">
                  You can lower your daily sending cap below the adaptive limit (minimum 5/day). Raising above the adaptive limit requires admin approval.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-fg block mb-1">Timezone</label>
                <input
                  type="text"
                  value={editingAccount.timezone || "UTC"}
                  onChange={(e) =>
                    setEditingAccount({ ...editingAccount, timezone: e.target.value })
                  }
                  className="input w-full text-xs h-9"
                />
              </div>

              {/* Warmup Settings in Edit Modal */}
              <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg flex items-center gap-1.5">
                    <Flame size={14} className="text-amber-500" /> Warm-up Schedule
                  </span>
                  <input
                    type="checkbox"
                    checked={editingAccount.warmup_enabled || false}
                    onChange={(e) =>
                      setEditingAccount({
                        ...editingAccount,
                        warmup_enabled: e.target.checked,
                      })
                    }
                    className="rounded h-4 w-4 cursor-pointer"
                  />
                </div>
                {editingAccount.warmup_enabled && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Current Day</label>
                      <input
                        type="number"
                        min={1}
                        value={editingAccount.warmup_day || 1}
                        onChange={(e) =>
                          setEditingAccount({
                            ...editingAccount,
                            warmup_day: Number(e.target.value),
                          })
                        }
                        className="input w-full text-xs h-8"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Max Warmup Limit</label>
                      <input
                        type="number"
                        value={editingAccount.warmup_max_limit || 50}
                        onChange={(e) =>
                          setEditingAccount({
                            ...editingAccount,
                            warmup_max_limit: Number(e.target.value),
                          })
                        }
                        className="input w-full text-xs h-8"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-fg block mb-1">Signature / Footer</label>
                <textarea
                  rows={3}
                  value={editingAccount.signature || ""}
                  onChange={(e) =>
                    setEditingAccount({ ...editingAccount, signature: e.target.value })
                  }
                  placeholder="Add a plain-text signature..."
                  className="input w-full text-xs resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingAccount(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={saving}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Gmail App Password Guide */}
      {isAppPasswordGuideOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-surface rounded-xl border border-border w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-base font-bold text-fg flex items-center gap-2">
                <HelpCircle size={16} className="text-primary" />
                How to Generate a Google App Password
              </h3>
              <button
                onClick={() => setIsAppPasswordGuideOpen(false)}
                className="text-muted hover:text-fg text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-muted leading-relaxed space-y-3">
              <p>
                Google does not allow third-party email tools to log in with your primary Gmail password. Instead, Google provides a secure 16-character <strong>App Password</strong>.
              </p>

              <div className="space-y-3 pt-1">
                <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-1">
                  <div className="font-semibold text-fg">Step 1: Turn on 2-Step Verification</div>
                  <p>
                    Go to your Google Account Security settings and confirm <strong>2-Step Verification</strong> is enabled.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-1">
                  <div className="font-semibold text-fg">Step 2: Go to App Passwords</div>
                  <p>
                    Visit the Google App Passwords page directly:
                  </p>
                  <a
                    href="https://myaccount.google.com/apppasswords"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline font-semibold inline-flex items-center gap-1 mt-1"
                  >
                    Open Google App Passwords <ExternalLink size={11} />
                  </a>
                </div>

                <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-1">
                  <div className="font-semibold text-fg">Step 3: Name and Generate</div>
                  <p>
                    In the app name box, type <strong>Lead Reach AI Outreach</strong> and click <strong>Create</strong>.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-bgSubtle border border-border space-y-1">
                  <div className="font-semibold text-fg">Step 4: Copy into Lead Reach AI</div>
                  <p>
                    Copy the yellow 16-character code (e.g. <code className="bg-surface px-1 py-0.5 rounded font-mono text-fg">abcd efgh ijkl mnop</code>) and paste it into the password field above.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-border flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setIsAppPasswordGuideOpen(false)}
              >
                Got It
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Custom In-UI Delete Confirmation */}
      {accountToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-surface rounded-xl border border-border w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-rose-500">
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
                <Trash2 size={20} />
              </div>
              <div>
                <h3 className="text-base font-bold text-fg">Remove Email Account?</h3>
                <p className="text-xs text-muted">This action will disconnect the sender inbox.</p>
              </div>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Are you sure you want to remove <strong className="text-fg">{accountToDelete.email}</strong>? Any active outreach campaigns will automatically rotate through your remaining active inboxes.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAccountToDelete(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={deletingId === accountToDelete.id}
                onClick={confirmDeleteAccount}
              >
                {deletingId === accountToDelete.id ? "Removing..." : "Remove Inbox"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
