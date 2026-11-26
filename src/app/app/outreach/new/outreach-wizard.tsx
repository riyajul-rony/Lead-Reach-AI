"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Users,
  Mail,
  Clock,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Plus,
  FileSpreadsheet,
  UploadCloud,
  Send,
  Calendar,
  AlertTriangle,
  Tag,
  FileText,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Loader2,
  Check,
  Inbox,
} from "lucide-react";
import { SPEED_PRESETS, SpeedPresetKey } from "@/components/outreach/sending-speed-card";
import { LeadSearchPicker } from "@/components/outreach/lead-search-picker";
import { GoogleSheetImporter } from "@/components/outreach/google-sheet-importer";
import { CsvImporter } from "@/components/outreach/csv-importer";
import {
  ValidationSummaryCard,
  ValidationSummaryData,
  PreviewItemData,
} from "@/components/outreach/validation-summary-card";
import { FollowupStepBuilder, FollowupStepData } from "@/components/outreach/followup-step-builder";
import { AiPreviewApprover, GeneratedPreview } from "@/components/outreach/ai-preview-approver";
import { SpamCheckResult } from "@/server/email/spam-checker";
import { analyzeDeliverability } from "@/server/email/deliverability-checker";
import { InfoTooltip } from "@/components/outreach/info-tooltip";
import { renderEmailTemplate } from "@/server/email/template-renderer";
import { formatFromHeader, resolveSenderFirstName } from "@/server/email/sender-identity";

interface EmailAccountItem {
  id: string;
  label: string;
  from_email: string;
  from_name: string;
  senderName?: string | null;
  hourly_limit: number;
  daily_limit?: number;
  effective_daily_limit?: number;
  remainingToday?: number;
  warmup_enabled?: boolean;
  warmup_day?: number;
  provider_id?: string;
  provider?: string;
  imap_host?: string | null;
  has_imap_password?: boolean;
  reply_inbox_account_id?: string | null;
  reply_inbox?: { id: string; label: string; from_email: string } | null;
  has_oauth_token?: boolean;
  min_gap_seconds?: number;
  max_gap_seconds?: number;
  gap_seconds?: number;
  status: string;
}

interface Recipient {
  email: string;
  name?: string;
  company?: string;
  website?: string;
  lead_id?: string;
  vars?: Record<string, any>;
}

const STEP_LABELS = [
  { step: 1, title: "Name & Type", subtitle: "Goal & AI mode", icon: Tag },
  { step: 2, title: "Add Leads", subtitle: "Upload or import", icon: Users },
  { step: 3, title: "Senders & Speed", subtitle: "Inboxes & pacing", icon: Mail },
  { step: 4, title: "Email Content", subtitle: "Subject & copy", icon: FileText },
  { step: 5, title: "Review & Launch", subtitle: "Summary & test", icon: CheckCircle2 },
];

const DRAFT_STORAGE_KEY = "leadreach_outreach_wizard_draft_v2";

export function OutreachWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get("mode") === "custom" ? "custom" : "ai";
  const initialSearchId = searchParams.get("search_id") || "";

  // Core Wizard Step State
  const [currentStep, setCurrentStep] = useState(1);
  const [draftRestored, setDraftRestored] = useState(false);

  // Step 1: Campaign Name & Type
  const [campaignName, setCampaignName] = useState(
    "Cold Outreach Campaign " + new Date().toLocaleDateString()
  );
  const [mode, setMode] = useState<"ai" | "custom">(initialMode);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // Advanced Settings
  const [timezone, setTimezone] = useState("Asia/Dhaka");
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1, 2, 3, 4, 5]);
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [trackingClick, setTrackingClick] = useState(false);
  const [trackingDomainId, setTrackingDomainId] = useState("");
  const [trackingDomains, setTrackingDomains] = useState<Array<{ id: string; domain: string; is_default?: boolean }>>([]);
  const [physicalAddress, setPhysicalAddress] = useState("");
  const [showRawPreview, setShowRawPreview] = useState(false);
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Step 2: Leads & Recipients
  const [recipientSource, setRecipientSource] = useState<"paste" | "leads" | "csv" | "sheet">(
    "leads"
  );
  const [pastedLeadsText, setPastedLeadsText] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [sourceRef, setSourceRef] = useState<Record<string, any>>({});
  const [validationSummary, setValidationSummary] = useState<ValidationSummaryData>({
    total: 0,
    valid: 0,
    duplicates: 0,
    suppressed: 0,
    invalidSyntax: 0,
  });
  const [previewItems, setPreviewItems] = useState<PreviewItemData[]>([]);

  // Step 3: Senders & Speed
  const [accounts, setAccounts] = useState<EmailAccountItem[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  interface AccountAllocState {
    leadCount: number;
    dailyLimit: number;
    minWaitMinutes: number;
    maxWaitMinutes: number;
  }
  const [accountAllocations, setAccountAllocations] = useState<Record<string, AccountAllocState>>({});
  const [presetMode, setPresetMode] = useState<"safe" | "balanced" | "custom">("balanced");

  // Step 4: Email Content
  const [subjectTemplate, setSubjectTemplate] = useState(
    "Quick question regarding {{company_name|your business}}"
  );
  const [bodyTemplate, setBodyTemplate] = useState(
    "Hi {{first_name|there}},\n\nI was looking at {{website|your company}} and wanted to reach out.\n\nWe help businesses like {{company_name|yours}} streamline customer acquisition and automation.\n\nDo you have 5 minutes for a quick chat this week?\n\nBest regards,\nAlex"
  );
  const [aiGoal, setAiGoal] = useState(
    "Offer local SEO & AI appointment automation to increase high-ticket leads"
  );
  const [aiTone, setAiTone] = useState("Friendly, low-pressure, direct");
  const [aiModel, setAiModel] = useState("gpt-4o-mini");
  const [isFollowupOpen, setIsFollowupOpen] = useState(false);
  const [followupSteps, setFollowupSteps] = useState<FollowupStepData[]>([]);
  const [previewsApproved, setPreviewsApproved] = useState(false);
  const [aiPreviews, setAiPreviews] = useState<GeneratedPreview[]>([]);
  const [spinSeed, setSpinSeed] = useState(0);
  const [enableAbTest, setEnableAbTest] = useState(false);
  const [variantBSubject, setVariantBSubject] = useState("");
  const [variantBBody, setVariantBBody] = useState("");

  // Spam checker & Pre-send deliverability state
  const [spamResult, setSpamResult] = useState<SpamCheckResult | null>(null);
  const [checkingSpam, setCheckingSpam] = useState(false);
  const [deliverabilityWarningsDismissed, setDeliverabilityWarningsDismissed] = useState(false);

  // Step 5: Test send & Launch states
  const [testEmailAddress, setTestEmailAddress] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testSendResult, setTestSendResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [acknowledgedNoReplyDetection, setAcknowledgedNoReplyDetection] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(true);
  const [legalTermsVersion, setLegalTermsVersion] = useState("2026-11-v1");
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [legalModalChecked, setLegalModalChecked] = useState(false);
  const [legalSubmitting, setLegalSubmitting] = useState(false);

  // 1. Restore draft on initial mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.campaignName) setCampaignName(d.campaignName);
        if (d.mode) setMode(d.mode);
        if (Array.isArray(d.recipients) && d.recipients.length > 0) {
          setRecipients(d.recipients);
          setValidationSummary({
            total: d.recipients.length,
            valid: d.recipients.length,
            duplicates: 0,
            suppressed: 0,
            invalidSyntax: 0,
          });
          setPreviewItems(
            d.recipients.slice(0, 15).map((r: any) => ({
              email: r.email,
              name: r.name || "",
              company: r.company || "",
              website: r.website || "",
              status: "ready",
            }))
          );
        }
        if (Array.isArray(d.selectedAccountIds) && d.selectedAccountIds.length > 0) {
          setSelectedAccountIds(d.selectedAccountIds);
        }
        if (d.subjectTemplate) setSubjectTemplate(d.subjectTemplate);
        if (d.bodyTemplate) setBodyTemplate(d.bodyTemplate);
        if (d.aiGoal) setAiGoal(d.aiGoal);
        if (d.aiTone) setAiTone(d.aiTone);
        if (d.timezone) setTimezone(d.timezone);
        setDraftRestored(true);
      }
    } catch {
      // Ignore parse error
    }
  }, []);

  // 2. Auto-save draft on state change
  useEffect(() => {
    try {
      const draftData = {
        campaignName,
        mode,
        recipients,
        selectedAccountIds,
        subjectTemplate,
        bodyTemplate,
        aiGoal,
        aiTone,
        timezone,
        updatedAt: Date.now(),
      };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftData));
    } catch {
      // Ignore quota error
    }
  }, [
    campaignName,
    mode,
    recipients,
    selectedAccountIds,
    subjectTemplate,
    bodyTemplate,
    aiGoal,
    aiTone,
    timezone,
  ]);

  const handleClearDraft = () => {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {}
    setCampaignName("Cold Outreach Campaign " + new Date().toLocaleDateString());
    setRecipients([]);
    setValidationSummary({ total: 0, valid: 0, duplicates: 0, suppressed: 0, invalidSyntax: 0 });
    setPreviewItems([]);
    setDraftRestored(false);
  };

  // Fetch accounts and verified tracking domains on mount
  useEffect(() => {
    fetch("/api/v1/email-accounts")
      .then((r) => r.json())
      .then((res) => {
        if (res.data) {
          setAccounts(res.data);
          const activeIds = res.data
            .filter((a: any) => a.status === "active")
            .map((a: any) => a.id);
          setSelectedAccountIds((prev) => (prev.length > 0 ? prev : activeIds));
        }
      })
      .finally(() => setLoadingAccounts(false));

    fetch("/api/v1/tracking-domains?limit=50")
      .then((r) => r.json())
      .then((res) => {
        const verified = (res.data?.items || []).filter((d: any) => d.status === "verified");
        setTrackingDomains(verified);
        const def = verified.find((d: any) => d.is_default);
        if (def) setTrackingDomainId((prev) => prev || def.id);
      })
      .catch(() => {});

    fetch("/api/v1/workspace/settings")
      .then((r) => r.json())
      .then((res) => {
        if (res.data?.business_address) {
          setPhysicalAddress(res.data.business_address);
        }
      })
      .catch(() => {});

    fetch("/api/v1/workspace/legal-acknowledgement")
      .then((r) => r.json())
      .then((res) => {
        if (res.data) {
          setLegalAccepted(Boolean(res.data.accepted));
          if (res.data.termsVersion) setLegalTermsVersion(res.data.termsVersion);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-distribute leads across selected accounts
  useEffect(() => {
    if (selectedAccountIds.length === 0) return;
    const totalLeads = recipients.length;
    const baseShare = Math.floor(totalLeads / selectedAccountIds.length);
    const remainder = totalLeads % selectedAccountIds.length;

    setAccountAllocations((prev) => {
      const next = { ...prev };
      selectedAccountIds.forEach((accId, idx) => {
        const acc = accounts.find((a) => a.id === accId);
        const prevAlloc = prev[accId];
        const assignedLeads = idx === 0 ? baseShare + remainder : baseShare;

        next[accId] = {
          leadCount: prevAlloc !== undefined ? prevAlloc.leadCount : assignedLeads,
          dailyLimit: prevAlloc?.dailyLimit || acc?.daily_limit || 75,
          minWaitMinutes:
            prevAlloc?.minWaitMinutes ||
            Number((((acc?.min_gap_seconds || acc?.gap_seconds || 180)) / 60).toFixed(1)),
          maxWaitMinutes:
            prevAlloc?.maxWaitMinutes ||
            Number((((acc?.max_gap_seconds || 420)) / 60).toFixed(1)),
        };
      });
      return next;
    });
  }, [selectedAccountIds, recipients.length, accounts]);

  // Allocation summary calculation
  const allocationSummary = useMemo(() => {
    const totalLeads = recipients.length;
    const selected = accounts.filter((a) => selectedAccountIds.includes(a.id));
    if (selected.length === 0 || totalLeads === 0) {
      return { totalDaily: 0, todayMax: 0, estimatedDays: 0, todaySends: 0 };
    }

    const totalDaily = selected.reduce((sum, a) => {
      const alloc = accountAllocations[a.id];
      const adaptiveCap = a.effective_daily_limit ?? a.daily_limit ?? 50;
      const requested = alloc?.dailyLimit || adaptiveCap;
      return sum + Math.min(requested, adaptiveCap);
    }, 0);

    const todayMax = selected.reduce((sum, a) => {
      const alloc = accountAllocations[a.id];
      const adaptiveCap = a.effective_daily_limit ?? a.daily_limit ?? 50;
      const requested = Math.min(alloc?.dailyLimit || adaptiveCap, adaptiveCap);
      const rem = a.remainingToday !== undefined ? Math.min(a.remainingToday, requested) : requested;
      return sum + Math.max(0, rem);
    }, 0);

    const estimatedDays = totalDaily > 0 ? Math.ceil(totalLeads / totalDaily) : 0;
    const todaySends = Math.min(totalLeads, todayMax);

    return { totalDaily, todayMax, estimatedDays, todaySends };
  }, [recipients.length, selectedAccountIds, accounts, accountAllocations]);

  const applyPresetToAccounts = (presetKey: SpeedPresetKey) => {
    const p = SPEED_PRESETS[presetKey];
    setAccountAllocations((prev) => {
      const next = { ...prev };
      selectedAccountIds.forEach((id) => {
        if (next[id]) {
          next[id] = {
            ...next[id],
            dailyLimit: p.dailyLimit,
            minWaitMinutes: p.minWaitMinutes,
            maxWaitMinutes: p.maxWaitMinutes,
          };
        }
      });
      return next;
    });
  };

  const copyFirstAccountSpeedToAll = () => {
    const firstId = selectedAccountIds[0];
    if (!firstId || !accountAllocations[firstId]) return;
    const ref = accountAllocations[firstId];
    setAccountAllocations((prev) => {
      const next = { ...prev };
      selectedAccountIds.forEach((id) => {
        if (next[id]) {
          next[id] = {
            ...next[id],
            dailyLimit: ref.dailyLimit,
            minWaitMinutes: ref.minWaitMinutes,
            maxWaitMinutes: ref.maxWaitMinutes,
          };
        }
      });
      return next;
    });
  };

  // Sample recipient for live preview
  const sampleRecipient = useMemo(() => {
    return (
      recipients[0] || {
        email: "sarah.connor@cyberdyne.io",
        name: "Sarah Connor",
        company: "Cyberdyne Systems",
        website: "cyberdyne.io",
      }
    );
  }, [recipients]);

  const primaryPreviewAccount = useMemo(() => {
    return accounts.find((a) => selectedAccountIds.includes(a.id)) || accounts[0] || null;
  }, [accounts, selectedAccountIds]);

  const previewVars = useMemo(
    () => ({
      first_name: sampleRecipient.name ? String(sampleRecipient.name).split(" ")[0] : "there",
      company_name: sampleRecipient.company || "your business",
      website: sampleRecipient.website || "your website",
      city: (sampleRecipient as any).city || "",
      business_address: physicalAddress.trim(),
      sender_first_name: resolveSenderFirstName(primaryPreviewAccount),
    }),
    [sampleRecipient, physicalAddress, primaryPreviewAccount]
  );

  const sampleUnsubscribeUrl = useMemo(() => {
    const selectedDomain = trackingDomains.find((d) => d.id === trackingDomainId)?.domain;
    const origin =
      selectedDomain
        ? `https://${selectedDomain}`
        : typeof window !== "undefined"
          ? window.location.origin
          : "https://app.leadreach.ai";
    return `${origin}/u/preview-sample`;
  }, [trackingDomains, trackingDomainId]);

  const makePreviewRng = (seedOffset: number) => {
    let state = (spinSeed * 1664525 + seedOffset + 1013904223) >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };

  const previewSubject = useMemo(() => {
    return renderEmailTemplate(subjectTemplate, previewVars, sampleUnsubscribeUrl, makePreviewRng(17));
  }, [subjectTemplate, previewVars, sampleUnsubscribeUrl, spinSeed]);

  const previewBody = useMemo(() => {
    return renderEmailTemplate(bodyTemplate, previewVars, sampleUnsubscribeUrl, makePreviewRng(73));
  }, [bodyTemplate, previewVars, sampleUnsubscribeUrl, spinSeed]);

  const previewRawMessage = useMemo(() => {
    const fromHeader = primaryPreviewAccount
      ? formatFromHeader(primaryPreviewAccount)
      : "you@example.com";
    const looksLikeHtml = /<(?:html|body|p|div|br|table|a|span)\b/i.test(previewBody);
    const contentType =
      trackingOpen || trackingClick
        ? "multipart/alternative (text/plain + tracking text/html)"
        : looksLikeHtml
          ? "multipart/alternative (text/plain + text/html)"
          : "text/plain; charset=utf-8";
    const headers = [
      `From: ${fromHeader}`,
      `To: ${sampleRecipient.email}`,
      `Subject: ${previewSubject}`,
      `Content-Type: ${contentType}`,
      `List-Unsubscribe: <${sampleUnsubscribeUrl}>`,
      `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    ];
    return `${headers.join("\n")}\n\n${previewBody}`;
  }, [
    primaryPreviewAccount,
    sampleRecipient.email,
    previewSubject,
    previewBody,
    trackingOpen,
    trackingClick,
    sampleUnsubscribeUrl,
  ]);

  // Live Spam Deliverability check with debouncing
  useEffect(() => {
    if (mode === "custom") {
      setCheckingSpam(true);
      const timer = setTimeout(() => {
        fetch("/api/v1/outreach/spam-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: subjectTemplate,
            body: bodyTemplate,
          }),
        })
          .then((r) => r.json())
          .then((json) => {
            if (json.data) setSpamResult(json.data);
          })
          .catch(() => {})
          .finally(() => setCheckingSpam(false));
      }, 400);

      return () => clearTimeout(timer);
    }
  }, [subjectTemplate, bodyTemplate, mode]);

  // Validation Callbacks
  const handleLeadsValidated = (result: {
    recipients: any[];
    summary: ValidationSummaryData;
    preview: PreviewItemData[];
    searchId: string;
    searchLabel: string;
  }) => {
    setRecipients(result.recipients);
    setValidationSummary(result.summary);
    setPreviewItems(result.preview);
    setSourceRef({
      search_id: result.searchId,
      search_label: result.searchLabel,
    });
  };

  const handleCsvValidated = (result: {
    recipients: any[];
    summary: ValidationSummaryData;
    preview: PreviewItemData[];
    fileName: string;
  }) => {
    setRecipients(result.recipients);
    setValidationSummary(result.summary);
    setPreviewItems(result.preview);
    setSourceRef({
      file_name: result.fileName,
    });
  };

  const handleSheetValidated = (result: {
    recipients: any[];
    summary: ValidationSummaryData;
    preview: PreviewItemData[];
    sheetTitle: string;
    spreadsheetId: string;
  }) => {
    setRecipients(result.recipients);
    setValidationSummary(result.summary);
    setPreviewItems(result.preview);
    setSourceRef({
      spreadsheet_id: result.spreadsheetId,
      sheet_title: result.sheetTitle,
    });
  };

  // Quick Paste Handler
  const handleProcessPastedText = () => {
    if (!pastedLeadsText.trim()) return;
    const lines = pastedLeadsText.split(/[\r\n]+/);
    const parsed: Recipient[] = [];
    const preview: PreviewItemData[] = [];
    let duplicates = 0;
    let invalidSyntax = 0;
    const seen = new Set<string>();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/[,\t]+/).map((p) => p.trim());
      const email = parts[0];
      const name = parts[1] || "";
      const company = parts[2] || "";

      if (!email || !email.includes("@") || !email.includes(".")) {
        invalidSyntax++;
        continue;
      }
      const lower = email.toLowerCase();
      if (seen.has(lower)) {
        duplicates++;
        continue;
      }
      seen.add(lower);

      parsed.push({ email, name, company });
      preview.push({
        email,
        name,
        company,
        website: "",
        status: "ready",
      });
    }

    setRecipients(parsed);
    setValidationSummary({
      total: lines.length,
      valid: parsed.length,
      duplicates,
      suppressed: 0,
      invalidSyntax,
    });
    setPreviewItems(preview.slice(0, 30));
    setSourceRef({ source: "manual_paste", count: parsed.length });
  };

  // Insert text or merge tag at the current cursor position in the message body
  const insertTextAtCursor = (snippet: string) => {
    const el = bodyTextareaRef.current;
    if (!el) {
      setBodyTemplate((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart ?? bodyTemplate.length;
    const end = el.selectionEnd ?? start;
    const nextValue = bodyTemplate.slice(0, start) + snippet + bodyTemplate.slice(end);
    setBodyTemplate(nextValue);
    requestAnimationFrame(() => {
      el.focus();
      const cursorPos = start + snippet.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  };

  const insertVariable = (varName: string) => {
    insertTextAtCursor(`{{${varName}}}`);
  };

  // Step validation checker
  const getStepValidation = (step: number): { valid: boolean; hint?: string } => {
    switch (step) {
      case 1:
        if (!campaignName.trim()) {
          return { valid: false, hint: "Enter a campaign name to continue" };
        }
        return { valid: true };
      case 2:
        if (recipients.length === 0) {
          return { valid: false, hint: "Add at least 1 lead to continue" };
        }
        return { valid: true };
      case 3:
        if (selectedAccountIds.length === 0) {
          return { valid: false, hint: "Select at least 1 sender email account" };
        }
        return { valid: true };
      case 4:
        if (!subjectTemplate.trim()) {
          return { valid: false, hint: "Enter an email subject" };
        }
        if (!bodyTemplate.trim()) {
          return { valid: false, hint: "Write email message body" };
        }
        return { valid: true };
      case 5:
        return { valid: true };
      default:
        return { valid: true };
    }
  };

  const currentStepCheck = getStepValidation(currentStep);

  // Send test email
  const handleSendTestEmail = async () => {
    if (!testEmailAddress || !testEmailAddress.includes("@")) {
      setTestSendResult({ ok: false, message: "Please enter a valid email address." });
      return;
    }
    const accountId = selectedAccountIds[0];
    if (!accountId) {
      setTestSendResult({
        ok: false,
        message: "Please select at least one sender email account in Step 3.",
      });
      return;
    }

    setTestSending(true);
    setTestSendResult(null);

    try {
      const res = await fetch("/api/v1/outreach/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          toEmail: testEmailAddress,
          subject: subjectTemplate,
          body: bodyTemplate,
          sampleData: {
            first_name: sampleRecipient.name?.split(" ")[0] || "Sarah",
            company_name: sampleRecipient.company || "Acme Dental",
            website: sampleRecipient.website || "acmedental.com",
            city: (sampleRecipient as any).city || "",
            business_address: physicalAddress.trim(),
          },
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to send test email");

      setTestSendResult({ ok: true, message: json.message || "Test email dispatched successfully!" });
    } catch (err: any) {
      setTestSendResult({ ok: false, message: err.message || "Failed to send test email." });
    } finally {
      setTestSending(false);
    }
  };

  // Launch campaign
  const handleLaunch = async (launchNow: boolean, bypassLegalCheck = false) => {
    if (launchNow && !bypassLegalCheck && !legalAccepted) {
      setLegalModalChecked(false);
      setLegalModalOpen(true);
      return;
    }

    setErrorMsg(null);
    setSubmitting(true);

    try {
      const payload = {
        name: campaignName,
        mode,
        senderAccountIds: selectedAccountIds,
        recipientSource,
        sourceRef,
        recipients,
        subjectTemplate,
        bodyTemplate,
        steps: followupSteps,
        variants:
          enableAbTest && variantBSubject.trim() && variantBBody.trim()
            ? [
                {
                  step_no: 0,
                  label: "A",
                  subject_template: subjectTemplate,
                  body_template: bodyTemplate,
                  weight: 50,
                },
                {
                  step_no: 0,
                  label: "B",
                  subject_template: variantBSubject,
                  body_template: variantBBody,
                  weight: 50,
                },
              ]
            : undefined,
        presetMode,
        daysOfWeek,
        trackingOpen,
        trackingClick,
        trackingDomainId: trackingDomainId || undefined,
        previewApproved: mode === "ai" ? previewsApproved : true,
        aiConfig: {
          goalOrOffer: aiGoal,
          tone: aiTone,
          textModel: aiModel,
        },
        sendWindow: {
          startHour,
          endHour,
        },
        timezone,
        jitterMinSec: 120,
        jitterMaxSec: 300,
        launchNow,
        accountAllocations: selectedAccountIds.map((id) => ({
          accountId: id,
          leadCount:
            accountAllocations[id]?.leadCount ??
            Math.floor(recipients.length / selectedAccountIds.length) ??
            0,
          dailyLimit: accountAllocations[id]?.dailyLimit,
          minWaitMinutes: accountAllocations[id]?.minWaitMinutes,
          maxWaitMinutes: accountAllocations[id]?.maxWaitMinutes,
        })),
      };

      const res = await fetch("/api/v1/outreach/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 422 && data.code === "LEGAL_ACKNOWLEDGEMENT_REQUIRED") {
          setLegalAccepted(false);
          if (data.termsVersion) setLegalTermsVersion(data.termsVersion);
          setLegalModalChecked(false);
          setLegalModalOpen(true);
          setSubmitting(false);
          return;
        }
        throw new Error(data.error || "Failed to create campaign");
      }

      try {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      } catch {}

      router.push(`/app/outreach/${data.data.campaign.id}`);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "An error occurred";
      const sanitized =
        raw.includes("prisma") ||
        raw.includes("invocation") ||
        raw.includes("SQL") ||
        raw.includes("argument") ||
        raw.includes("Expected RecipientSource")
          ? "We couldn't launch your campaign. Please try again."
          : raw;
      setErrorMsg(sanitized);
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Draft Notice */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">New Outreach Campaign</h1>
          <p className="text-xs text-muted mt-0.5">
            5 simple steps to safely launch multi-inbox cold email campaigns.
          </p>
        </div>

        {draftRestored && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-bgSubtle border border-border text-xs text-muted">
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
              <Check size={13} /> Draft auto-saved
            </span>
            <button
              type="button"
              onClick={handleClearDraft}
              className="text-muted hover:text-danger flex items-center gap-1 transition-colors"
              title="Discard draft and start fresh"
            >
              <RotateCcw size={12} /> Clear
            </button>
          </div>
        )}
      </div>

      {/* Top Progress Bar & Stepper Tabs */}
      <div className="space-y-3">
        {/* Visual Progress Bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="font-semibold text-fg">
              Step {currentStep} of 5: {STEP_LABELS[currentStep - 1].title}
            </span>
            <span>{Math.round((currentStep / 5) * 100)}% Completed</span>
          </div>
          <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--brand-emerald)] rounded-full transition-all duration-300"
              style={{ width: `${(currentStep / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* 5 Stepper Buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {STEP_LABELS.map((s) => {
            const Icon = s.icon;
            const isActive = currentStep === s.step;
            const isDone = currentStep > s.step;
            return (
              <button
                key={s.step}
                type="button"
                id={`wizard-step-${s.step}`}
                onClick={() => {
                  if (s.step < currentStep || currentStepCheck.valid) {
                    setCurrentStep(s.step);
                  }
                }}
                className={`flex items-center gap-2.5 p-3 rounded-[8px] border text-xs font-medium transition-colors text-left cursor-pointer ${
                  isActive
                    ? "bg-[var(--brand-emerald)] text-[var(--brand-emerald-fg)] border-[var(--brand-emerald)] font-semibold shadow-xs"
                    : isDone
                    ? "bg-bgSubtle border-border text-fg hover:border-borderStrong hover:bg-surface"
                    : "bg-surface border-border text-muted hover:text-fg hover:border-borderStrong hover:bg-bgSubtle"
                }`}
              >
                <Icon size={16} className="shrink-0" />
                <div className="truncate">
                  {isDone ? (
                    <span className="block text-[10px] uppercase font-mono font-semibold text-[var(--badge-success-text)]">
                      ✓ Step {s.step}
                    </span>
                  ) : (
                    <span
                      className={`block text-[10px] uppercase font-mono ${
                        isActive ? "text-[var(--brand-emerald-fg)]/80 font-semibold" : "text-muted"
                      }`}
                    >
                      Step {s.step}
                    </span>
                  )}
                  <span className="font-semibold">{s.title}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* ========================================================== */}
      {/* STEP 1: CAMPAIGN NAME & TYPE                               */}
      {/* ========================================================== */}
      {currentStep === 1 && (
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-8 space-y-6">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2 text-fg">
              <Tag className="text-primary" size={20} /> Step 1: Campaign Name &amp; Message Type
            </h2>
            <p className="text-xs text-muted mt-1">
              Give your campaign a memorable name and choose how messages should be personalized.
            </p>
          </div>

          <div className="space-y-5 max-w-2xl">
            {/* Campaign Name */}
            <div>
              <label className="text-xs font-semibold text-fg block mb-1.5">
                Campaign Name <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                className="w-full px-3.5 py-2 text-sm rounded-lg border border-border bg-bgSubtle text-fg placeholder:text-muted focus:outline-hidden focus:border-primary"
                placeholder="e.g. Q4 London Agency Outreach"
              />
            </div>

            {/* Mode Selection Cards */}
            <div>
              <label className="text-xs font-semibold text-fg block mb-2">
                Choose Message Type
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <button
                  type="button"
                  onClick={() => setMode("ai")}
                  className={`p-4 rounded-xl border text-left transition-all ${
                    mode === "ai"
                      ? "border-primary bg-primary/5 shadow-xs"
                      : "border-border bg-bgSubtle/40 hover:border-border/80"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Sparkles size={16} />
                    </span>
                    <Badge variant={mode === "ai" ? "accent" : "neutral"} size="sm">
                      Recommended
                    </Badge>
                  </div>
                  <h3 className="font-bold text-sm text-fg mt-3">AI Personalized Message</h3>
                  <p className="text-xs text-muted mt-1 leading-relaxed">
                    Lead Reach AI reads each lead&apos;s website, industry, and company to generate unique high-converting opening lines.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setMode("custom")}
                  className={`p-4 rounded-xl border text-left transition-all ${
                    mode === "custom"
                      ? "border-primary bg-primary/5 shadow-xs"
                      : "border-border bg-bgSubtle/40 hover:border-border/80"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-bgSubtle border border-border text-fg">
                      <FileText size={16} />
                    </span>
                    <Badge variant="neutral" size="sm">
                      Standard
                    </Badge>
                  </div>
                  <h3 className="font-bold text-sm text-fg mt-3">Regular Template Copy</h3>
                  <p className="text-xs text-muted mt-1 leading-relaxed">
                    Send your own proven message copy with dynamic merge tags like <code className="font-mono text-fg bg-bgSubtle px-1 py-0.5 rounded">{"{{first_name}}"}</code> and <code className="font-mono text-fg bg-bgSubtle px-1 py-0.5 rounded">{"{{company_name}}"}</code>.
                  </p>
                </button>
              </div>
            </div>

            {/* Collapsible Advanced Settings */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
                className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-fg transition-colors"
              >
                <span>Advanced sending schedule &amp; compliance settings</span>
                {isAdvancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {isAdvancedOpen && (
                <div className="mt-3 p-4 rounded-xl border border-border bg-bgSubtle space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs font-medium text-fg">Timezone</label>
                        <InfoTooltip
                          title="Local Timezone Matching"
                          content="Sends emails according to your prospect's local timezone so messages arrive at the top of their inbox during active work hours."
                        />
                      </div>
                      <input
                        type="text"
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-fg"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs font-medium text-fg">
                          Sending Window (Hours)
                        </label>
                        <InfoTooltip
                          title="Business Hours Window"
                          content="Emails will only be dispatched between these hours (e.g. 9 AM - 6 PM) to mimic genuine human work schedules."
                        />
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={startHour}
                          onChange={(e) => setStartHour(Number(e.target.value))}
                          className="w-16 px-2 py-1.5 rounded-lg border border-border bg-surface text-fg text-center"
                        />
                        <span>to</span>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={endHour}
                          onChange={(e) => setEndHour(Number(e.target.value))}
                          className="w-16 px-2 py-1.5 rounded-lg border border-border bg-surface text-fg text-center"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs font-medium text-fg">
                        Workspace Business Address (Optional)
                      </label>
                      <InfoTooltip
                        title="Optional Merge Variable"
                        content="Nothing is ever auto-appended to your emails. If you want to display your postal address, save it here and click 'Insert address' or type {{business_address}} in your message template."
                      />
                    </div>
                    <input
                      type="text"
                      value={physicalAddress}
                      onChange={(e) => setPhysicalAddress(e.target.value)}
                      onBlur={() => {
                        fetch("/api/v1/workspace/settings", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ business_address: physicalAddress.trim() || null }),
                        }).catch(() => {});
                      }}
                      placeholder="Optional — used only when {{business_address}} is in your template"
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-fg"
                    />
                  </div>

                  <div className="rounded-lg border border-border bg-surface p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-fg">
                        Tracking (Off by default for deliverability)
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-5 text-xs">
                      <label className="flex items-center gap-2 cursor-pointer select-none text-fg">
                        <input
                          type="checkbox"
                          checked={trackingOpen}
                          onChange={(e) => setTrackingOpen(e.target.checked)}
                          className="checkbox checkbox-xs"
                        />
                        <span>Open tracking (hidden 1x1 pixel)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer select-none text-fg">
                        <input
                          type="checkbox"
                          checked={trackingClick}
                          onChange={(e) => setTrackingClick(e.target.checked)}
                          className="checkbox checkbox-xs"
                        />
                        <span>Click tracking (rewrites links)</span>
                      </label>
                    </div>
                    <p className="text-[11px] text-muted">
                      Click tracking rewrites links, open tracking adds a hidden image; both can hurt inbox placement.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-fg">
                        Custom Tracking Domain (Optional)
                      </label>
                      <Link
                        href="/app/settings/integrations"
                        className="text-[11px] text-primary hover:underline"
                      >
                        Manage Domains
                      </Link>
                    </div>
                    <select
                      value={trackingDomainId}
                      onChange={(e) => setTrackingDomainId(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-fg"
                    >
                      <option value="">Default App Domain</option>
                      {trackingDomains.map((td) => (
                        <option key={td.id} value={td.id}>
                          https://{td.domain} {td.is_default ? "(Default)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Step 1 Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Link href="/app/outreach">
              <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />}>
                Cancel
              </Button>
            </Link>

            <div className="flex items-center gap-3">
              {!currentStepCheck.valid && (
                <span className="text-xs text-amber-500 font-medium">
                  {currentStepCheck.hint}
                </span>
              )}
              <Button
                type="button"
                id="btn-next-step-1"
                disabled={!currentStepCheck.valid}
                onClick={() => setCurrentStep(2)}
                variant="primary"
                size="md"
                rightIcon={<ArrowRight size={16} />}
              >
                Continue to Leads
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* STEP 2: ADD LEADS                                          */}
      {/* ========================================================== */}
      {currentStep === 2 && (
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2 text-fg">
                <Users className="text-primary" size={20} /> Step 2: Add Campaign Leads
              </h2>
              <p className="text-xs text-muted mt-1">
                Choose how you want to provide your recipient list. All leads are automatically deduplicated.
              </p>
            </div>

            {recipients.length > 0 && (
              <Badge variant="success" size="md" className="font-mono">
                {recipients.length} Leads Ready
              </Badge>
            )}
          </div>

          <div className="space-y-4">
            {/* 3 Lead Source Tabs */}
            <div className="flex gap-2 p-1.5 rounded-xl bg-bgSubtle border border-border">
              <button
                type="button"
                id="lead-source-leads"
                onClick={() => setRecipientSource("leads")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                  recipientSource === "leads"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-muted hover:text-fg"
                }`}
              >
                Lead Reach AI Scraper Leads
              </button>

              <button
                type="button"
                id="lead-source-csv"
                onClick={() => setRecipientSource("csv")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                  recipientSource === "csv"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-muted hover:text-fg"
                }`}
              >
                <UploadCloud className="inline-block w-3.5 h-3.5 mr-1" /> Upload CSV
              </button>

              <button
                type="button"
                id="lead-source-paste"
                onClick={() => setRecipientSource("paste")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                  recipientSource === "paste"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-muted hover:text-fg"
                }`}
              >
                Paste Emails / Text
              </button>

              <button
                type="button"
                id="lead-source-sheet"
                onClick={() => setRecipientSource("sheet")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors hidden md:block ${
                  recipientSource === "sheet"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-muted hover:text-fg"
                }`}
              >
                <FileSpreadsheet className="inline-block w-3.5 h-3.5 mr-1" /> Google Sheets
              </button>
            </div>

            {/* Active Source Content */}
            {recipientSource === "leads" && (
              <LeadSearchPicker
                initialSearchId={initialSearchId}
                onValidated={handleLeadsValidated}
              />
            )}

            {recipientSource === "csv" && (
              <CsvImporter onValidated={handleCsvValidated} />
            )}

            {recipientSource === "sheet" && (
              <GoogleSheetImporter onValidated={handleSheetValidated} />
            )}

            {recipientSource === "paste" && (
              <div className="p-4 rounded-xl border border-border bg-bgSubtle space-y-3">
                <div>
                  <label className="text-xs font-semibold text-fg block mb-1">
                    Paste emails list (one per line, optionally with Name and Company)
                  </label>
                  <p className="text-[11px] text-muted mb-2">
                    Format: <code className="font-mono text-fg bg-surface px-1 py-0.5 rounded">email@domain.com, John Doe, Acme Corp</code> or just <code className="font-mono text-fg bg-surface px-1 py-0.5 rounded">email@domain.com</code>
                  </p>
                  <textarea
                    rows={5}
                    value={pastedLeadsText}
                    onChange={(e) => setPastedLeadsText(e.target.value)}
                    placeholder="sarah@dentalpro.com, Sarah Connor, Dental Pro&#10;john@techcorp.io, John Doe, Tech Corp"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-surface text-fg font-mono placeholder:text-muted focus:outline-hidden focus:border-primary"
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleProcessPastedText}
                  disabled={!pastedLeadsText.trim()}
                  icon={<Plus size={14} />}
                >
                  Process &amp; Validate Leads
                </Button>
              </div>
            )}

            {/* Validation Summary & Preview Table */}
            {recipients.length > 0 && (
              <ValidationSummaryCard
                summary={validationSummary}
                preview={previewItems}
              />
            )}
          </div>

          {/* Step 2 Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCurrentStep(1)}
              icon={<ArrowLeft size={14} />}
            >
              Back to Name
            </Button>

            <div className="flex items-center gap-3">
              {!currentStepCheck.valid && (
                <span className="text-xs text-amber-500 font-medium">
                  {currentStepCheck.hint}
                </span>
              )}
              <Button
                type="button"
                id="btn-next-step-2"
                disabled={!currentStepCheck.valid}
                onClick={() => setCurrentStep(3)}
                variant="primary"
                size="md"
                rightIcon={<ArrowRight size={16} />}
              >
                Continue to Senders &amp; Speed
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* STEP 3: SENDERS & SPEED ALLOCATION (PHASE A INTEGRATION)  */}
      {/* ========================================================== */}
      {currentStep === 3 && (
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-8 space-y-6">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2 text-fg">
              <Mail className="text-primary" size={20} /> Step 3: Sender Accounts &amp; Sending Speed
            </h2>
            <p className="text-xs text-muted mt-1">
              Select which sender inboxes to rotate and set random human-like wait delays.
            </p>
          </div>

          {loadingAccounts ? (
            <div className="py-8 text-center text-xs text-muted">Loading email accounts...</div>
          ) : accounts.length === 0 ? (
            <div className="p-6 rounded-xl bg-bgSubtle border border-border text-center space-y-3">
              <AlertCircle size={28} className="mx-auto text-amber-500" />
              <h3 className="font-semibold text-sm text-fg">No Email Inboxes Connected</h3>
              <p className="text-xs text-muted max-w-sm mx-auto">
                You must connect at least one business email or Gmail inbox before cold dispatches can begin.
              </p>
              <Link href="/app/outreach/email-accounts">
                <Button variant="primary" size="sm" icon={<Plus size={14} />}>
                  Connect Email Account
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Speed Preset Quick Bar */}
              <div className="p-3.5 rounded-xl border border-border bg-bgSubtle flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-fg">One-Click Speed Presets</div>
                  <div className="text-[11px] text-muted">
                    Apply recommended wait intervals and caps across all selected accounts.
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPresetToAccounts("safe")}
                    className="text-xs"
                  >
                    🛡️ Safe (5–10m)
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPresetToAccounts("balanced")}
                    className="text-xs"
                  >
                    ⚖️ Balanced (3–6m)
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPresetToAccounts("fast")}
                    className="text-xs"
                  >
                    ⚡ Fast (2.5–4m)
                  </Button>
                  {selectedAccountIds.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={copyFirstAccountSpeedToAll}
                      className="text-xs"
                    >
                      Copy #1 to all
                    </Button>
                  )}
                </div>
              </div>

              {/* Per-Account Allocation & Speed Table */}
              <div className="border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-bgSubtle border-b border-border text-xs font-semibold text-fg flex items-center justify-between">
                  <span>Selected Senders ({selectedAccountIds.length} of {accounts.length})</span>
                  <span>Target: {recipients.length} total leads</span>
                </div>

                <div className="divide-y divide-border">
                  {accounts.map((acc) => {
                    const isSelected = selectedAccountIds.includes(acc.id);
                    const alloc = accountAllocations[acc.id] || {
                      leadCount: 0,
                      dailyLimit: acc.daily_limit || 75,
                      minWaitMinutes: 3,
                      maxWaitMinutes: 6,
                    };
                    const hourlyMax = Math.floor(60 / Math.max(0.1, alloc.minWaitMinutes || 3));

                    return (
                      <div
                        key={acc.id}
                        className={`p-4 transition-colors ${
                          isSelected ? "bg-surface" : "bg-bgSubtle/30 opacity-60"
                        }`}
                      >
                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                          {/* Account Label & Checkbox */}
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedAccountIds((prev) => [...prev, acc.id]);
                                } else {
                                  setSelectedAccountIds((prev) => prev.filter((id) => id !== acc.id));
                                }
                              }}
                              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                            />
                            <div>
                              <div className="text-xs font-semibold text-fg">{acc.label}</div>
                              <div className="text-[11px] text-muted font-mono">{acc.from_email}</div>
                            </div>
                          </div>

                          {/* Allocation Controls */}
                          {isSelected && (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center text-xs">
                              {/* Leads Assigned Stepper */}
                              <div className="space-y-1">
                                <span className="text-[10px] text-muted uppercase font-bold block">
                                  Leads
                                </span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setAccountAllocations((prev) => ({
                                        ...prev,
                                        [acc.id]: {
                                          ...alloc,
                                          leadCount: Math.max(0, alloc.leadCount - 10),
                                        },
                                      }))
                                    }
                                    className="px-2 py-0.5 rounded border border-border bg-bgSubtle hover:bg-surface text-fg font-mono"
                                  >
                                    -
                                  </button>
                                  <input
                                    type="number"
                                    min={0}
                                    value={alloc.leadCount}
                                    onChange={(e) =>
                                      setAccountAllocations((prev) => ({
                                        ...prev,
                                        [acc.id]: {
                                          ...alloc,
                                          leadCount: Math.max(0, parseInt(e.target.value, 10) || 0),
                                        },
                                      }))
                                    }
                                    className="w-14 text-center font-mono py-1 rounded border border-border bg-bgSubtle text-fg text-xs"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setAccountAllocations((prev) => ({
                                        ...prev,
                                        [acc.id]: {
                                          ...alloc,
                                          leadCount: alloc.leadCount + 10,
                                        },
                                      }))
                                    }
                                    className="px-2 py-0.5 rounded border border-border bg-bgSubtle hover:bg-surface text-fg font-mono"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>

                              {/* Daily Limit */}
                              <div className="space-y-1">
                                <span className="text-[10px] text-muted uppercase font-bold block">
                                  Daily Cap
                                </span>
                                <input
                                  type="number"
                                  min={5}
                                  max={500}
                                  value={alloc.dailyLimit}
                                  onChange={(e) =>
                                    setAccountAllocations((prev) => ({
                                      ...prev,
                                      [acc.id]: {
                                        ...alloc,
                                        dailyLimit: Math.max(5, parseInt(e.target.value, 10) || 5),
                                      },
                                    }))
                                  }
                                  className="w-20 font-mono py-1 px-2 rounded border border-border bg-bgSubtle text-fg text-xs"
                                />
                              </div>

                              {/* Wait Gap Range */}
                              <div className="space-y-1">
                                <span className="text-[10px] text-muted uppercase font-bold block">
                                  Wait Range
                                </span>
                                <div className="flex items-center gap-1 font-mono text-xs">
                                  <input
                                    type="number"
                                    step={0.5}
                                    min={0.5}
                                    max={60}
                                    value={alloc.minWaitMinutes}
                                    onChange={(e) =>
                                      setAccountAllocations((prev) => ({
                                        ...prev,
                                        [acc.id]: {
                                          ...alloc,
                                          minWaitMinutes: Math.max(0.5, parseFloat(e.target.value) || 0.5),
                                        },
                                      }))
                                    }
                                    className="w-12 py-1 px-1 text-center rounded border border-border bg-bgSubtle text-fg"
                                  />
                                  <span>–</span>
                                  <input
                                    type="number"
                                    step={0.5}
                                    min={alloc.minWaitMinutes}
                                    max={60}
                                    value={alloc.maxWaitMinutes}
                                    onChange={(e) =>
                                      setAccountAllocations((prev) => ({
                                        ...prev,
                                        [acc.id]: {
                                          ...alloc,
                                          maxWaitMinutes: Math.max(
                                            alloc.minWaitMinutes,
                                            parseFloat(e.target.value) || alloc.minWaitMinutes
                                          ),
                                        },
                                      }))
                                    }
                                    className="w-12 py-1 px-1 text-center rounded border border-border bg-bgSubtle text-fg"
                                  />
                                  <span className="text-muted text-[11px]">m</span>
                                </div>
                              </div>

                              {/* Max Speed */}
                              <div className="space-y-1 text-right sm:text-left">
                                <span className="text-[10px] text-muted uppercase font-bold block">
                                  Hourly Speed
                                </span>
                                <span className="text-xs font-semibold text-fg">
                                  ~{hourlyMax} / hr
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Prominent Live Summary Banner */}
              <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3 text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-semibold text-primary flex items-center gap-1.5">
                      <CheckCircle2 size={15} />
                      <span>Live Campaign Schedule Estimate</span>
                    </div>
                    <p className="text-fg leading-relaxed">
                      At this rate, sending to <strong>{recipients.length}</strong> leads will take approximately{" "}
                      <strong>{allocationSummary.estimatedDays} {allocationSummary.estimatedDays === 1 ? "day" : "days"}</strong>.{" "}
                      Available capacity today across selected inboxes: <strong>{allocationSummary.todayMax}</strong>{" "}
                      (sending <strong>{allocationSummary.todaySends}</strong> today).
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold font-mono text-fg">
                      ~{allocationSummary.totalDaily} / day
                    </div>
                    <span className="text-[11px] text-muted">Across selected inboxes</span>
                  </div>
                </div>

                {recipients.length > allocationSummary.todayMax && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-500" />
                    <span>
                      Lead volume ({recipients.length}) exceeds today&apos;s available adaptive capacity ({allocationSummary.todayMax}).{" "}
                      <strong>{allocationSummary.todaySends}</strong> emails will send today and the remaining{" "}
                      <strong>{recipients.length - allocationSummary.todayMax}</strong> will continue automatically across subsequent days.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3 Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCurrentStep(2)}
              icon={<ArrowLeft size={14} />}
            >
              Back to Leads
            </Button>

            <div className="flex items-center gap-3">
              {!currentStepCheck.valid && (
                <span className="text-xs text-amber-500 font-medium">
                  {currentStepCheck.hint}
                </span>
              )}
              <Button
                type="button"
                id="btn-next-step-3"
                disabled={!currentStepCheck.valid}
                onClick={() => setCurrentStep(4)}
                variant="primary"
                size="md"
                rightIcon={<ArrowRight size={16} />}
              >
                Continue to Email Content
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* STEP 4: EMAIL CONTENT & AI COPY                           */}
      {/* ========================================================== */}
      {currentStep === 4 && (
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-8 space-y-6">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2 text-fg">
              <FileText className="text-primary" size={20} /> Step 4: Email Content &amp; Copy
            </h2>
            <p className="text-xs text-muted mt-1">
              {mode === "ai"
                ? "Configure the AI prompt and sample message. The AI will customize the opening line for each prospect."
                : "Write your outreach message template. Click variable chips below to insert merge tags."}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Column: Subject & Body Editor */}
            <div className="space-y-4">
              {/* Subject */}
              <div>
                <label className="text-xs font-semibold text-fg block mb-1">
                  Subject Line <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={subjectTemplate}
                  onChange={(e) => setSubjectTemplate(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bgSubtle text-fg placeholder:text-muted focus:outline-hidden focus:border-primary"
                  placeholder="e.g. Quick question regarding {{company_name}}"
                />
              </div>

              {/* Variable Chips Toolbar */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <span>Insert tag:</span>
                  <InfoTooltip
                    title="Merge Tags with Fallbacks"
                    content="Click to insert personalized prospect data. You can set fallback values like {{first_name|there}} which will print 'there' if the lead has no first name."
                  />
                </div>
                {["first_name", "company_name", "website", "city", "sender_first_name"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-bgSubtle border border-border text-fg hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                  >
                    + {`{{${v}}}`}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => insertTextAtCursor("\n\nUnsubscribe: {{unsubscribe_url}}")}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface border border-border text-fg hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                >
                  Insert unsubscribe line
                </button>
                <button
                  type="button"
                  onClick={() => insertTextAtCursor("\n{{business_address}}")}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface border border-border text-fg hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                >
                  Insert address
                </button>
              </div>

              {/* Email Body */}
              <div>
                <label className="text-xs font-semibold text-fg block mb-1">
                  Message Body <span className="text-danger">*</span>
                </label>
                <textarea
                  ref={bodyTextareaRef}
                  rows={8}
                  value={bodyTemplate}
                  onChange={(e) => setBodyTemplate(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bgSubtle text-fg font-sans leading-relaxed placeholder:text-muted focus:outline-hidden focus:border-primary"
                  placeholder="Write your email copy here..."
                />
              </div>

              {/* Optional A/B Test Variant B (Initial Email) */}
              {mode === "custom" && (
                <div className="p-3.5 rounded-xl border border-border bg-bgSubtle space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-fg">A/B Test Variant B (Optional, 50/50 Split)</div>
                      <div className="text-[11px] text-muted">
                        Test an alternate subject and body on the initial email.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!enableAbTest) {
                          if (!variantBSubject) setVariantBSubject(subjectTemplate);
                          if (!variantBBody) setVariantBBody(bodyTemplate);
                        }
                        setEnableAbTest(!enableAbTest);
                      }}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-surface border border-border text-fg hover:border-primary/50 transition-colors cursor-pointer"
                    >
                      {enableAbTest ? "Remove Variant B" : "+ Add Variant B"}
                    </button>
                  </div>

                  {enableAbTest && (
                    <div className="space-y-2.5 pt-2 border-t border-border">
                      <div>
                        <label className="text-[11px] font-medium text-muted block mb-1">
                          Variant B Subject
                        </label>
                        <input
                          type="text"
                          value={variantBSubject}
                          onChange={(e) => setVariantBSubject(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-fg focus:outline-hidden focus:border-primary"
                          placeholder="Variant B subject line..."
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted block mb-1">
                          Variant B Body
                        </label>
                        <textarea
                          rows={5}
                          value={variantBBody}
                          onChange={(e) => setVariantBBody(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-fg font-sans leading-relaxed focus:outline-hidden focus:border-primary"
                          placeholder="Variant B email body..."
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* AI Prompt / Goal if AI mode is active */}
              {mode === "ai" && (
                <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                    <Sparkles size={14} />
                    <span>AI Personalization Prompt</span>
                  </div>
                  <textarea
                    rows={2}
                    value={aiGoal}
                    onChange={(e) => setAiGoal(e.target.value)}
                    placeholder="e.g. Compliment their recent portfolio work and offer custom appointment automation"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-surface text-fg focus:outline-hidden focus:border-primary"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted">Tone:</span>
                    <input
                      type="text"
                      value={aiTone}
                      onChange={(e) => setAiTone(e.target.value)}
                      className="px-2 py-1 text-xs rounded border border-border bg-surface text-fg flex-1"
                    />
                  </div>
                </div>
              )}

              {/* Collapsible Follow-up Sequences Accordion */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setIsFollowupOpen(!isFollowupOpen)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-fg transition-colors"
                >
                  <span>Automated Follow-up Sequences (Optional)</span>
                  {isFollowupOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {isFollowupOpen && (
                  <div className="mt-3 p-4 rounded-xl border border-border bg-bgSubtle space-y-3">
                    <FollowupStepBuilder
                      steps={followupSteps}
                      onChange={setFollowupSteps}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Live Prospect Preview & Spam Checker */}
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-bgSubtle p-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-muted border-b border-border pb-2 gap-2 flex-wrap">
                  <span className="font-semibold text-fg">Live Preview for Lead #1</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono">{sampleRecipient.email}</span>
                    <button
                      type="button"
                      onClick={() => setShowRawPreview((v) => !v)}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                        showRawPreview
                          ? "bg-primary/10 border-primary text-primary"
                          : "bg-surface border-border text-fg hover:border-primary/50"
                      }`}
                    >
                      Raw message
                    </button>
                    <button
                      type="button"
                      onClick={() => setSpinSeed((s) => s + 1)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface border border-border text-fg hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                      title="Sample another spintax variation"
                    >
                      <RotateCcw size={11} /> Spin Preview
                    </button>
                  </div>
                </div>

                {showRawPreview ? (
                  <pre className="p-3.5 rounded-lg border border-border bg-surface text-fg leading-relaxed whitespace-pre-wrap font-mono text-[11px] overflow-x-auto">
                    {previewRawMessage}
                  </pre>
                ) : (
                  <div className="space-y-2 text-xs">
                    <div>
                      <span className="text-muted">Subject: </span>
                      <strong className="text-fg">{previewSubject}</strong>
                    </div>
                    <div className="p-3.5 rounded-lg border border-border bg-surface text-fg leading-relaxed whitespace-pre-wrap font-sans text-xs">
                      {previewBody}
                    </div>
                  </div>
                )}
              </div>

              {/* Spam Check Score Badge */}
              {mode === "custom" && (
                <div className="p-3.5 rounded-xl border border-border bg-surface flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      size={16}
                      className={
                        spamResult && spamResult.score > 2 ? "text-amber-500" : "text-emerald-500"
                      }
                    />
                    <div>
                      <div className="font-semibold text-fg">Deliverability Check</div>
                      <div className="text-[11px] text-muted">
                        {checkingSpam
                          ? "Analyzing deliverability score..."
                          : spamResult
                          ? `Risk Score: ${spamResult.score}/10 (${spamResult.level} risk)`
                          : "Subject and body verified for inboxing"}
                      </div>
                    </div>
                  </div>

                  {spamResult && (
                    <Badge
                      variant={spamResult.score > 2 ? "warning" : "success"}
                      size="sm"
                    >
                      {spamResult.score > 2 ? "Caution" : "High Inboxing"}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Step 4 Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCurrentStep(3)}
              icon={<ArrowLeft size={14} />}
            >
              Back to Senders
            </Button>

            <div className="flex items-center gap-3">
              {!currentStepCheck.valid && (
                <span className="text-xs text-amber-500 font-medium">
                  {currentStepCheck.hint}
                </span>
              )}
              <Button
                type="button"
                id="btn-next-step-4"
                disabled={!currentStepCheck.valid}
                onClick={() => setCurrentStep(5)}
                variant="primary"
                size="md"
                rightIcon={<ArrowRight size={16} />}
              >
                Continue to Review &amp; Launch
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* STEP 5: REVIEW & LAUNCH (PLAIN-LANGUAGE SUMMARY & TEST)    */}
      {/* ========================================================== */}
      {currentStep === 5 && (
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-8 space-y-6">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2 text-fg">
              <CheckCircle2 className="text-emerald-500" size={20} /> Step 5: Review &amp; Launch
            </h2>
            <p className="text-xs text-muted mt-1">
              Everything is ready. Review your campaign parameters or send a test email before launching dispatches.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left 2 Columns: Review Cards */}
            <div className="lg:col-span-2 space-y-4">
              {/* Summary Overview */}
              <div className="rounded-xl border border-border bg-bgSubtle p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div>
                    <h3 className="font-bold text-sm text-fg">{campaignName}</h3>
                    <p className="text-xs text-muted">
                      {mode === "ai" ? "AI Personalized Icebreaker" : "Standard Template Copy"}
                    </p>
                  </div>
                  <Badge variant={mode === "ai" ? "accent" : "neutral"} size="sm">
                    {mode === "ai" ? "AI Powered" : "Template"}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 rounded-lg border border-border bg-surface">
                    <span className="text-[10px] text-muted uppercase font-bold block">
                      Total Leads
                    </span>
                    <strong className="text-base text-fg">{recipients.length}</strong>
                  </div>

                  <div className="p-3 rounded-lg border border-border bg-surface">
                    <span className="text-[10px] text-muted uppercase font-bold block">
                      Senders Rotating
                    </span>
                    <strong className="text-base text-fg">{selectedAccountIds.length} Inboxes</strong>
                  </div>

                  <div className="p-3 rounded-lg border border-border bg-surface">
                    <span className="text-[10px] text-muted uppercase font-bold block">
                      Daily Dispatches
                    </span>
                    <strong className="text-base text-fg">~{allocationSummary.totalDaily} / day</strong>
                  </div>

                  <div className="p-3 rounded-lg border border-border bg-surface">
                    <span className="text-[10px] text-muted uppercase font-bold block">
                      Estimated Duration
                    </span>
                    <strong className="text-base text-fg">
                      ~{allocationSummary.estimatedDays} Days
                    </strong>
                  </div>
                </div>

                {/* Safety Protections Banner */}
                <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <ShieldCheck size={14} className="text-emerald-500" />
                    <span>Lead Reach AI Safety Protections Active</span>
                  </div>
                  <p className="text-[11px] text-muted">
                    • 25/hr maximum account rate limit hard cap enforced.
                    <br />• Human-like random intervals between 3 to 7 minutes per sender inbox.
                    <br />• IMAP Stop-On-Reply protection automatically halts followups when a prospect responds.
                  </p>
                </div>
              </div>

              {/* Email Content Snippet */}
              <div className="rounded-xl border border-border bg-surface p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-fg">Email Message Preview:</span>
                  <button
                    type="button"
                    onClick={() => setShowRawPreview((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                      showRawPreview
                        ? "bg-primary/10 border-primary text-primary"
                        : "bg-bgSubtle border-border text-fg hover:border-primary/50"
                    }`}
                  >
                    Raw message
                  </button>
                </div>
                {showRawPreview ? (
                  <pre className="p-3 rounded-lg border border-border bg-bgSubtle whitespace-pre-wrap font-mono text-[11px] overflow-x-auto">
                    {previewRawMessage}
                  </pre>
                ) : (
                  <>
                    <div className="text-muted">
                      <strong>Subject: </strong> {previewSubject}
                    </div>
                    <div className="p-3 rounded-lg border border-border bg-bgSubtle whitespace-pre-wrap font-sans text-xs">
                      {previewBody}
                    </div>
                  </>
                )}
              </div>

              {/* Pre-send Deliverability Check */}
              {(() => {
                const selectedAccountsList = accounts.filter((a) => selectedAccountIds.includes(a.id));
                const deliverability = analyzeDeliverability({
                  subject: previewSubject,
                  body: previewBody,
                  rawSubjectTemplate: subjectTemplate,
                  rawBodyTemplate: bodyTemplate,
                  mode,
                  stepNo: 1,
                  senderAccounts: selectedAccountsList,
                  recipients,
                  trackingOpen,
                  trackingClick,
                  businessAddress: physicalAddress,
                  steps: followupSteps.map((s) => ({
                    step_no: s.step_no,
                    subject: s.subject,
                    body: s.body,
                    tracking_open: s.tracking_open ?? null,
                    tracking_click: s.tracking_click ?? null,
                  })),
                });

                return (
                  <div className="rounded-xl border border-border bg-surface p-4 space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-semibold text-fg flex items-center gap-1.5">
                        <ShieldCheck size={14} className="text-primary" />
                        <span>Deliverability check</span>
                      </span>
                      <Badge
                        variant={
                          deliverability.status === "error"
                            ? "danger"
                            : deliverability.status === "warn"
                              ? "warning"
                              : "success"
                        }
                        size="sm"
                      >
                        {deliverability.status === "error"
                          ? `${deliverability.errors.length} Blocking Error(s)`
                          : deliverability.status === "warn"
                            ? `${deliverability.warnings.length} Warning(s)`
                            : "All checks passed"}
                      </Badge>
                    </div>

                    {deliverability.errors.length === 0 && deliverability.warnings.length === 0 && (
                      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                        Your rendered message, sender identity, DNS, and recipient list look clean ({deliverability.summary.wordCount} words, {deliverability.summary.linkCount} links).
                      </p>
                    )}

                    {deliverability.errors.length > 0 && (
                      <div className="space-y-1.5">
                        {deliverability.errors.map((issue) => (
                          <div
                            key={issue.code + issue.title}
                            className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-700 dark:text-rose-300"
                          >
                            <div className="font-semibold">{issue.title}</div>
                            <div className="text-[11px] opacity-90">{issue.message}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {deliverability.warnings.length > 0 && (
                      <div className="space-y-2">
                        {!deliverabilityWarningsDismissed && (
                          <div className="space-y-1.5">
                            {deliverability.warnings.map((issue) => (
                              <div
                                key={issue.code + issue.title}
                                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-300"
                              >
                                <div className="font-semibold">{issue.title}</div>
                                <div className="text-[11px] opacity-90">{issue.message}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
                          <input
                            type="checkbox"
                            checked={deliverabilityWarningsDismissed}
                            onChange={(e) => setDeliverabilityWarningsDismissed(e.target.checked)}
                            className="rounded cursor-pointer"
                          />
                          <span>
                            {deliverabilityWarningsDismissed
                              ? "Warnings dismissed — click to inspect warnings again"
                              : "Dismiss deliverability warnings"}
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Reply Detection & Follow-up Warnings */}
              {(() => {
                const selectedAccountsList = accounts.filter((a) => selectedAccountIds.includes(a.id));
                const accountsWithoutReplyDetection = selectedAccountsList.filter((a) => {
                  const hasDirect = Boolean(a.imap_host && (a.has_imap_password || a.has_imap_password === undefined));
                  const hasLinked = Boolean(a.reply_inbox_account_id || a.reply_inbox);
                  const hasFlag = (a as any).has_reply_detection === true;
                  return !hasFlag && !hasDirect && !hasLinked;
                });
                const hasNoReplyDetection = accountsWithoutReplyDetection.length > 0;
                const hasFollowups = followupSteps.length > 0;

                return (
                  <>
                    {hasNoReplyDetection && hasFollowups && (
                      <div className="p-4 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs space-y-3 text-rose-900 dark:text-rose-200">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle size={18} className="text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <div className="font-bold text-sm text-rose-800 dark:text-rose-300">
                              For follow-ups and stop-on-reply, connect with App Password + IMAP
                            </div>
                            <p className="text-[11px] text-muted leading-relaxed">
                              The selected sender inbox (
                              <strong className="text-fg">
                                {accountsWithoutReplyDetection.map((a) => a.from_email).join(", ")}
                              </strong>
                              ) does not have reply detection configured (no IMAP or linked reply inbox). Because incoming replies cannot be detected, follow-up sequences cannot be safely executed. Only initial emails may be sent.
                            </p>
                          </div>
                        </div>

                        <div className="pt-2 border-t border-rose-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setFollowupSteps([]);
                              setIsFollowupOpen(false);
                            }}
                            className="text-xs shrink-0"
                          >
                            Turn off follow-ups for this campaign
                          </Button>
                        </div>
                      </div>
                    )}

                    {hasNoReplyDetection && (
                      <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs flex items-center gap-2 text-amber-800 dark:text-amber-300">
                        <AlertCircle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
                        <span>⚠ For follow-ups and stop-on-reply, connect with App Password + IMAP.</span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Right Column: Send Test & Launch Box */}
            <div className="space-y-4">
              {/* Send Test Email Card */}
              <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                <div className="text-xs font-semibold text-fg flex items-center gap-1.5">
                  <Send size={13} className="text-primary" />
                  <span>Send a Test Email</span>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  Send a sample of this email to your personal inbox to verify formatting and spam filtering.
                </p>

                <div className="space-y-2">
                  <input
                    type="email"
                    value={testEmailAddress}
                    onChange={(e) => setTestEmailAddress(e.target.value)}
                    placeholder="your-email@gmail.com"
                    className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-bgSubtle text-fg placeholder:text-muted focus:outline-hidden focus:border-primary"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleSendTestEmail}
                    disabled={testSending || !testEmailAddress}
                    icon={testSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    className="w-full"
                  >
                    {testSending ? "Sending Test..." : "Send Test Email"}
                  </Button>
                </div>

                {testSendResult && (
                  <div
                    className={`p-2.5 rounded-lg text-[11px] ${
                      testSendResult.ok
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : "bg-danger/10 text-danger border border-danger/20"
                    }`}
                  >
                    {testSendResult.message}
                  </div>
                )}
              </div>

              {/* Big Launch Buttons */}
              {(() => {
                const selectedAccountsList = accounts.filter((a) => selectedAccountIds.includes(a.id));
                const accountsWithoutReplyDetection = selectedAccountsList.filter((a) => {
                  const hasDirect = Boolean(a.imap_host && (a.has_imap_password || a.has_imap_password === undefined));
                  const hasLinked = Boolean(a.reply_inbox_account_id || a.reply_inbox);
                  const hasFlag = (a as any).has_reply_detection === true;
                  return !hasFlag && !hasDirect && !hasLinked;
                });
                const hasNoReplyDetection = accountsWithoutReplyDetection.length > 0;
                const hasFollowups = followupSteps.length > 0;
                const deliverabilityCheck = analyzeDeliverability({
                  subject: previewSubject,
                  body: previewBody,
                  rawSubjectTemplate: subjectTemplate,
                  rawBodyTemplate: bodyTemplate,
                  mode,
                  stepNo: 1,
                  senderAccounts: selectedAccountsList,
                  recipients,
                  trackingOpen,
                  trackingClick,
                  businessAddress: physicalAddress,
                  steps: followupSteps.map((s) => ({
                    step_no: s.step_no,
                    subject: s.subject,
                    body: s.body,
                    tracking_open: s.tracking_open ?? null,
                    tracking_click: s.tracking_click ?? null,
                  })),
                });
                const isLaunchBlocked =
                  (hasNoReplyDetection && hasFollowups) || !deliverabilityCheck.canLaunch;

                return (
                  <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                    <Button
                      type="button"
                      id="btn-launch-campaign"
                      variant="primary"
                      size="lg"
                      onClick={() => handleLaunch(true)}
                      disabled={submitting || isLaunchBlocked}
                      icon={submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                      className="w-full justify-center"
                    >
                      {submitting ? "Launching..." : "Launch Campaign Now"}
                    </Button>

                    {!deliverabilityCheck.canLaunch && (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400 text-center font-medium leading-relaxed">
                        Resolve {deliverabilityCheck.errors.length} blocking deliverability error(s) before launching.
                      </p>
                    )}

                    {isLaunchBlocked && (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400 text-center font-medium leading-relaxed">
                        Cannot launch with follow-up steps: sender account lacks reply detection. For follow-ups and stop-on-reply, connect with App Password + IMAP, or turn off follow-ups.
                      </p>
                    )}

                    <Button
                      type="button"
                      variant="secondary"
                      size="md"
                      onClick={() => handleLaunch(false)}
                      disabled={submitting}
                      className="w-full justify-center text-xs"
                    >
                      Save as Draft (Don&apos;t Launch)
                    </Button>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Step 5 Back Action */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCurrentStep(4)}
              icon={<ArrowLeft size={14} />}
            >
              Back to Email Content
            </Button>
          </div>
        </div>
      )}

      {legalModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="legal-ack-title"
        >
          <div className="bg-surface rounded-xl border border-border max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="space-y-1">
              <h3 id="legal-ack-title" className="text-base font-bold text-fg">
                Outreach Compliance Acknowledgement (v{legalTermsVersion})
              </h3>
              <p className="text-xs text-muted leading-relaxed">
                Before launching your workspace&apos;s campaign, please confirm your compliance obligations under our{" "}
                <Link href="/terms" target="_blank" className="text-primary hover:underline font-medium">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/acceptable-use" target="_blank" className="text-primary hover:underline font-medium">
                  Acceptable Use Policy
                </Link>
                .
              </p>
            </div>

            <label className="flex items-start gap-2.5 p-3.5 rounded-lg border border-border bg-bgSubtle text-xs text-fg cursor-pointer select-none">
              <input
                type="checkbox"
                checked={legalModalChecked}
                onChange={(e) => setLegalModalChecked(e.target.checked)}
                className="checkbox checkbox-xs mt-0.5 shrink-0"
              />
              <span className="leading-relaxed">
                I confirm that I am solely responsible for including a valid postal address and a working opt-out method where applicable law requires, and that I have a lawful basis to contact all recipients in this workspace.
              </span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setLegalModalOpen(false)}
                disabled={legalSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!legalModalChecked || legalSubmitting}
                onClick={async () => {
                  setLegalSubmitting(true);
                  try {
                    const res = await fetch("/api/v1/workspace/legal-acknowledgement", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ accepted: true, termsVersion: legalTermsVersion }),
                    });
                    if (!res.ok) {
                      const json = await res.json().catch(() => ({}));
                      throw new Error(json.error || "Could not record acknowledgement");
                    }
                    setLegalAccepted(true);
                    setLegalModalOpen(false);
                    await handleLaunch(true, true);
                  } catch (err: any) {
                    setErrorMsg(err?.message || "Failed to save compliance acknowledgement");
                    setLegalModalOpen(false);
                  } finally {
                    setLegalSubmitting(false);
                  }
                }}
              >
                {legalSubmitting ? "Confirming..." : "Accept & Launch Campaign"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
