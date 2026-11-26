"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";

/**
 * Strips all whitespace characters from a pasted Gmail App Password
 * (e.g. "abcd efgh ijkl mnop" -> "abcdefghijklmnop").
 */
export function stripAppPasswordSpaces(raw: string): string {
  return String(raw || "").replace(/\s+/g, "");
}

interface GmailAppPasswordGuideProps {
  compact?: boolean;
}

export function GmailAppPasswordGuide({ compact = false }: GmailAppPasswordGuideProps) {
  return (
    <div
      className={`rounded-xl border border-border bg-bgSubtle ${
        compact ? "p-3.5 space-y-2" : "p-5 space-y-3"
      }`}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck size={15} className="text-primary shrink-0" />
        <h3 className={`${compact ? "text-xs" : "text-sm"} font-semibold text-fg`}>
          How to create a Gmail App Password (4 easy steps)
        </h3>
      </div>

      <ol
        className={`space-y-1.5 ${
          compact ? "text-[11px]" : "text-xs"
        } text-muted list-decimal list-inside`}
      >
        <li>
          <span className="text-fg font-medium">Turn on 2-Step Verification:</span>{" "}
          Open{" "}
          <a
            href="https://myaccount.google.com/security"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
          >
            Google Account Security <ExternalLink size={11} />
          </a>{" "}
          and enable 2-Step Verification.
        </li>
        <li>
          <span className="text-fg font-medium">Create an App Password:</span>{" "}
          Visit{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
          >
            Google App Passwords <ExternalLink size={11} />
          </a>{" "}
          and generate one named <code className="font-mono text-fg bg-surface px-1 py-0.5 rounded border border-border">LeadReachAI</code>.
        </li>
        <li>
          <span className="text-fg font-medium">Enable IMAP in Gmail Settings:</span>{" "}
          Go to <strong className="text-fg">Gmail Settings → Forwarding and POP/IMAP</strong> and make sure IMAP is enabled.
        </li>
        <li>
          <span className="text-fg font-medium">Copy &amp; paste the 16-character password here:</span>{" "}
          Spaces like <code className="font-mono text-fg">abcd efgh ijkl mnop</code> are stripped automatically before testing or saving.
        </li>
      </ol>
    </div>
  );
}
