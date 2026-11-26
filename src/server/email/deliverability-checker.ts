import { analyzeSpamRisk } from "@/server/email/spam-checker";
import { resolveSenderFirstName } from "@/server/email/sender-identity";

export type DeliverabilitySeverity = "error" | "warn";

export interface DeliverabilityIssue {
  code: string;
  severity: DeliverabilitySeverity;
  title: string;
  message: string;
}

export interface DeliverabilityAccountInput {
  id?: string;
  from_email?: string | null;
  from_name?: string | null;
  senderName?: string | null;
  dns_spf_status?: string | null;
  dns_dkim_status?: string | null;
  dns_dmarc_status?: string | null;
  status?: string | null;
}

export interface DeliverabilityRecipientInput {
  email?: string | null;
  name?: string | null;
  company?: string | null;
}

export interface DeliverabilityCheckInput {
  subject: string;
  body: string;
  rawSubjectTemplate?: string;
  rawBodyTemplate?: string;
  mode?: "template" | "custom" | "ai";
  stepNo?: number;
  senderAccounts?: DeliverabilityAccountInput[];
  recipients?: DeliverabilityRecipientInput[];
  trackingOpen?: boolean;
  trackingClick?: boolean;
  businessAddress?: string | null;
  steps?: Array<{
    step_no?: number;
    subject?: string;
    body?: string;
    tracking_open?: boolean | null;
    tracking_click?: boolean | null;
  }>;
}

export interface DeliverabilityCheckResult {
  status: "pass" | "warn" | "error";
  canLaunch: boolean;
  errors: DeliverabilityIssue[];
  warnings: DeliverabilityIssue[];
  summary: {
    wordCount: number;
    linkCount: number;
    spamScore: number;
  };
}

export const MISSING_ADDRESS_OR_OPTOUT_WARNING_MESSAGE =
  "Your text has no postal address or opt-out line. For US/UK recipients commercial email generally requires both (CAN-SPAM, PECR/GDPR). The List-Unsubscribe header is still sent.";

const URL_SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "rb.gy",
  "is.gd",
  "cutt.ly",
  "shorturl.at",
  "buff.ly",
  "rebrand.ly",
]);

const GENERIC_OR_BRAND_NAME_PATTERN =
  /\b(lead\s*reach(\s*ai)?|cerkit|autohub|no-?reply|donotreply|support|sales|marketing|admin|team|newsletter|outreach|notifications?)\b/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function hasBrokenSpintax(rawText: string): boolean {
  if (!rawText) return false;
  // Strip valid {{...}} merge variables first so double-braces aren't misread as single-brace spintax
  const withoutMergeVars = rawText.replace(/\{\{[^{}]*\}\}/g, "");
  // Unmatched { or }
  let depth = 0;
  for (let i = 0; i < withoutMergeVars.length; i++) {
    const ch = withoutMergeVars[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return true;
    }
  }
  if (depth !== 0) return true;

  // Inspect {...} groups: empty `{}` or empty branch `{a|}` or `{|a}` or `{a||b}`
  const braceGroups = withoutMergeVars.match(/\{[^{}]*\}/g) || [];
  for (const g of braceGroups) {
    const inner = g.slice(1, -1);
    if (!inner.trim()) return true;
    if (inner.includes("|")) {
      const parts = inner.split("|");
      if (parts.some((p) => p.trim().length === 0)) {
        return true;
      }
    } else {
      // Single-brace non-spintax token like {first_name} left unclosed/malformed
      return true;
    }
  }
  return false;
}

function extractUrls(text: string): string[] {
  const matches = new Set<string>();
  const urlRegex = /(?:https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRegex.exec(text)) !== null) {
    matches.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  const hrefRegex = /href=["']([^"']+)["']/gi;
  while ((m = hrefRegex.exec(text)) !== null) {
    if (/^(https?:)?\/\//i.test(m[1])) {
      matches.add(m[1]);
    }
  }
  return Array.from(matches);
}

function parseHostname(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractSignatureCandidateName(body: string): string | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/unsubscribe|opt.?out|remove me|http:\/\/|https:\/\/|\/u\//i.test(l)
    );
  if (lines.length === 0) return null;

  const tail = lines.slice(-3);
  const signoffMarkers = /^(best|cheers|thanks|thank you|regards|warm regards|sincerely|talk soon|best regards)[,!.]*$/i;
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i];
    if (signoffMarkers.test(line) && i + 1 < tail.length) {
      const candidate = tail[i + 1].replace(/[^a-zA-Z\s-]/g, "").trim();
      const firstWord = candidate.split(/\s+/)[0];
      if (firstWord && firstWord.length >= 2 && firstWord.length <= 25) {
        return firstWord.toLowerCase();
      }
    }
  }

  // Last short standalone single/two-word line (e.g., "Alex" or "Alex Carter")
  const last = tail[tail.length - 1];
  if (last && /^[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?$/.test(last)) {
    return last.split(/\s+/)[0].toLowerCase();
  }
  return null;
}

function detectOptOutAndAddress(body: string, businessAddress?: string | null) {
  const lower = body.toLowerCase();
  const hasOptOut =
    /\/u\/|unsubscribe|opt[- ]?out|reply\s+["']?stop|stop receiving|remove me from/i.test(
      body
    );

  const cleanAddr = (businessAddress || "").trim().toLowerCase();
  const hasWorkspaceAddressRendered = Boolean(
    cleanAddr.length >= 8 && lower.includes(cleanAddr)
  );
  const hasAddressHeuristic =
    /\b\d{1,6}\s+[a-zA-Z0-9.'-]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|way|lane|ln|dr|drive|ste|suite|floor|fl|plaza|court|ct)\b/i.test(
      body
    ) || /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(body);

  return {
    hasOptOut,
    hasPostalAddress: hasWorkspaceAddressRendered || hasAddressHeuristic,
  };
}

/**
 * Pure pre-send deliverability & compliance checker (zero network calls).
 */
export function analyzeDeliverability(
  input: DeliverabilityCheckInput
): DeliverabilityCheckResult {
  const errors: DeliverabilityIssue[] = [];
  const warnings: DeliverabilityIssue[] = [];

  const subject = (input.subject || "").trim();
  const body = (input.body || "").trim();
  const rawSubject = input.rawSubjectTemplate ?? subject;
  const rawBody = input.rawBodyTemplate ?? body;
  const mode = input.mode ?? "template";
  const stepNo = input.stepNo ?? 1;
  const accounts = input.senderAccounts || [];
  const recipients = input.recipients || [];

  // ── BLOCKING ERRORS ─────────────────────────────────────────────
  if (!subject) {
    errors.push({
      code: "empty_subject",
      severity: "error",
      title: "Subject line is required",
      message: "Enter a non-empty email subject line before launching.",
    });
  }

  if ((mode === "template" || mode === "custom") && !body) {
    errors.push({
      code: "empty_body",
      severity: "error",
      title: "Email body is empty",
      message: "Write the email message body before launching this campaign.",
    });
  }

  if (/\{\{[^{}]+\}\}/.test(subject) || /\{\{[^{}]+\}\}/.test(body)) {
    errors.push({
      code: "unresolved_variables",
      severity: "error",
      title: "Unresolved template placeholders detected",
      message:
        "One or more {{variable}} tags could not be rendered in the sample preview. Provide lead fields or a fallback (e.g. {{first_name|there}}).",
    });
  }

  if (
    hasBrokenSpintax(rawSubject) ||
    hasBrokenSpintax(rawBody) ||
    hasBrokenSpintax(subject) ||
    hasBrokenSpintax(body)
  ) {
    errors.push({
      code: "malformed_spintax",
      severity: "error",
      title: "Broken or unclosed spintax detected",
      message:
        "Fix unclosed '{' / '}' braces or empty spintax variants such as {Hello|} before sending.",
    });
  }

  if (recipients.length === 0) {
    errors.push({
      code: "no_recipients",
      severity: "error",
      title: "No recipients selected",
      message: "Import or select at least one valid recipient lead before launching.",
    });
  } else {
    const invalidEmails = recipients.filter(
      (r) => !r.email || !EMAIL_RE.test(String(r.email).trim())
    );
    if (invalidEmails.length > 0) {
      errors.push({
        code: "invalid_recipients",
        severity: "error",
        title: "Invalid recipient email addresses",
        message: `${invalidEmails.length} recipient row(s) have invalid or empty email addresses.`,
      });
    }
  }

  if (accounts.length === 0) {
    errors.push({
      code: "no_sender_account",
      severity: "error",
      title: "No sender mailbox selected",
      message: "Select at least one active sender email account.",
    });
  } else {
    const missingFromEmail = accounts.filter(
      (a) => !a.from_email || !EMAIL_RE.test(a.from_email.trim())
    );
    const activeAccounts = accounts.filter(
      (a) => !a.status || a.status === "active"
    );
    if (missingFromEmail.length > 0) {
      errors.push({
        code: "invalid_sender_email",
        severity: "error",
        title: "Invalid sender email configuration",
        message: "One or more selected sender accounts do not have a valid From email address.",
      });
    }
    if (activeAccounts.length === 0) {
      errors.push({
        code: "no_active_sender",
        severity: "error",
        title: "No active sender mailbox available",
        message:
          "All selected sender accounts are paused or require attention. Resume or reconnect a mailbox first.",
      });
    }
  }

  for (const acc of accounts) {
    const spfFail = acc.dns_spf_status === "fail";
    const dkimFail = acc.dns_dkim_status === "fail";
    const dmarcFail = acc.dns_dmarc_status === "fail";
    if (spfFail || dkimFail || dmarcFail) {
      const failing = [
        spfFail ? "SPF" : null,
        dkimFail ? "DKIM" : null,
        dmarcFail ? "DMARC" : null,
      ].filter(Boolean);
      errors.push({
        code: "dns_authentication_fail",
        severity: "error",
        title: `DNS failure on ${acc.from_email || "sender domain"}`,
        message: `${failing.join(", ")} check failed for ${acc.from_email || "this account"}. Fix domain DNS records before launching.`,
      });
    }
  }

  // ── DISMISSIBLE WARNINGS ────────────────────────────────────────
  const senderDomains = new Set(
    accounts
      .map((a) => (a.from_email || "").split("@")[1]?.toLowerCase().trim())
      .filter(Boolean) as string[]
  );

  const signatureFirst = extractSignatureCandidateName(body);
  for (const acc of accounts) {
    const displayName = (acc.senderName ?? acc.from_name ?? "").trim();
    if (!displayName || GENERIC_OR_BRAND_NAME_PATTERN.test(displayName)) {
      warnings.push({
        code: "generic_or_missing_from_name",
        severity: "warn",
        title: `Check From Name on ${acc.from_email || "sender"}`,
        message: !displayName
          ? `Sender ${acc.from_email || ""} has no human From Name configured. Add your real name to improve open rates and trust.`
          : `Sender From Name "${displayName}" looks like a product or role address rather than a personal human name.`,
      });
    } else if (signatureFirst) {
      const senderFirst = resolveSenderFirstName(acc)?.toLowerCase();
      if (senderFirst && senderFirst !== signatureFirst) {
        warnings.push({
          code: "from_name_signature_mismatch",
          severity: "warn",
          title: "From Name does not match signature",
          message: `From Name starts with "${resolveSenderFirstName(acc)}", while your message appears signed as "${signatureFirst}". Align your From Name with your signature.`,
        });
      }
    }

    const dnsMissing =
      acc.dns_spf_status === "unknown" ||
      acc.dns_dmarc_status === "unknown" ||
      !acc.dns_spf_status ||
      !acc.dns_dmarc_status;
    const anyFail =
      acc.dns_spf_status === "fail" ||
      acc.dns_dkim_status === "fail" ||
      acc.dns_dmarc_status === "fail";
    if (dnsMissing && !anyFail) {
      warnings.push({
        code: "dns_unverified",
        severity: "warn",
        title: `DNS not yet verified for ${acc.from_email || "sender"}`,
        message:
          "SPF or DMARC status is unknown/unverified for this account. Run a connection test or verify domain DNS records.",
      });
    }
  }

  const urls = extractUrls(body);
  if (stepNo === 1 && urls.length > 0) {
    warnings.push({
      code: "step1_links_present",
      severity: "warn",
      title: "Links present in Step 1 email",
      message:
        "Your initial email includes a clickable link. Removing links in Step 1 significantly reduces spam filtering in cold outreach.",
    });
  }

  const shorteners: string[] = [];
  const crossDomainUrls: string[] = [];
  const longUrls: string[] = [];
  for (const url of urls) {
    const host = parseHostname(url);
    if (host && URL_SHORTENERS.has(host)) {
      shorteners.push(host);
    }
    if (
      host &&
      senderDomains.size > 0 &&
      !Array.from(senderDomains).some((d) => host === d || host.endsWith(`.${d}`))
    ) {
      crossDomainUrls.push(host);
    }
    if (url.length > 80) {
      longUrls.push(url);
    }
  }

  if (shorteners.length > 0) {
    warnings.push({
      code: "url_shortener",
      severity: "warn",
      title: "URL shortener detected",
      message: `Shortened links (${Array.from(new Set(shorteners)).join(", ")}) are heavily penalized by Gmail/Workspace spam filters.`,
    });
  }
  if (crossDomainUrls.length > 0) {
    warnings.push({
      code: "cross_domain_link",
      severity: "warn",
      title: "Link points to a different domain than sender",
      message: `Found link(s) pointing to external domain(s) (${Array.from(new Set(crossDomainUrls)).slice(0, 2).join(", ")}) instead of the sender's domain.`,
    });
  }
  if (longUrls.length > 0) {
    warnings.push({
      code: "long_url",
      severity: "warn",
      title: "Long URL (>80 characters) detected",
      message:
        "URLs longer than 80 characters look automated or tracked and can hurt inbox placement.",
    });
  }

  const anyStepOpen = (input.steps || []).some((s) => s.tracking_open === true);
  const anyStepClick = (input.steps || []).some((s) => s.tracking_click === true);
  if (input.trackingOpen || input.trackingClick || anyStepOpen || anyStepClick) {
    warnings.push({
      code: "tracking_enabled",
      severity: "warn",
      title: "Open or click tracking enabled",
      message:
        "Click tracking rewrites links and open tracking adds a hidden image; keeping both OFF gives the highest primary-inbox placement.",
    });
  }

  const { hasOptOut, hasPostalAddress } = detectOptOutAndAddress(
    body,
    input.businessAddress
  );
  if (!hasOptOut || !hasPostalAddress) {
    warnings.push({
      code: "missing_address_or_optout",
      severity: "warn",
      title: "No postal address or opt-out line in body",
      message: MISSING_ADDRESS_OR_OPTOUT_WARNING_MESSAGE,
    });
  }

  const spam = analyzeSpamRisk(subject, body);
  const triggerFlags = spam.flags.filter((f) => f.type === "trigger_word");
  if (triggerFlags.length > 0) {
    warnings.push({
      code: "spam_trigger_words",
      severity: "warn",
      title: "Promotional / spam trigger phrases found",
      message: `Found risky trigger phrasing: ${triggerFlags
        .map((f) => `"${f.word}"`)
        .slice(0, 4)
        .join(", ")}.`,
    });
  }

  const exclamationCount = (`${subject} ${body}`.match(/!/g) || []).length;
  const hasCapsFlag = spam.flags.some((f) => f.type === "caps");
  const hasExcessiveCapsWord = /\b[A-Z]{4,}\b/.test(`${subject} ${body}`);
  if (hasCapsFlag || hasExcessiveCapsWord || exclamationCount > 1) {
    warnings.push({
      code: "caps_or_exclamations",
      severity: "warn",
      title: "Excessive caps or exclamation marks",
      message:
        "Avoid ALL CAPS words and multiple '!' punctuation marks to keep a natural human tone.",
    });
  }

  const plainBody = body.replace(/<[^>]+>/g, " ").trim();
  const wordCount = plainBody ? plainBody.split(/\s+/).length : 0;
  if (wordCount > 250) {
    warnings.push({
      code: "body_too_long",
      severity: "warn",
      title: `Long email (${wordCount} words)`,
      message:
        "Cold outreach over 250 words gets fewer replies and increases filtering risk. Aim for 60–150 words.",
    });
  }

  if (/<(?:html|body|div|p|table|span|br|img|a)\b/i.test(body)) {
    warnings.push({
      code: "html_in_body",
      severity: "warn",
      title: "HTML markup detected in message body",
      message:
        "Plain-text messages without HTML tags consistently outperform HTML templates in cold outreach.",
    });
  }

  const status: DeliverabilityCheckResult["status"] =
    errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "pass";

  return {
    status,
    canLaunch: errors.length === 0,
    errors,
    warnings,
    summary: {
      wordCount,
      linkCount: urls.length,
      spamScore: spam.score,
    },
  };
}
