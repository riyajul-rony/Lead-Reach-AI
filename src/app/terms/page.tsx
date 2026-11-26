import type { Metadata } from "next";
import Link from "next/link";
import { FileText, ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

const TERMS_DESCRIPTION =
  "Terms of Service, compliance responsibilities (CAN-SPAM, GDPR, PECR), anti-spam rules, and suspension terms for Lead Reach AI.";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: TERMS_DESCRIPTION,
  alternates: {
    canonical: "/terms",
  },
  openGraph: {
    type: "website",
    url: "/terms",
    title: "Terms of Service | Lead Reach AI",
    description: TERMS_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Terms of Service | Lead Reach AI",
    description: TERMS_DESCRIPTION,
  },
};

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-bg text-fg py-16 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl rounded-xl border border-border bg-surface p-6 sm:p-10 space-y-8 shadow-sm">
        <div className="flex items-center justify-between border-b border-border pb-6">
          <Link href="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={14} className="mr-1.5" /> Back to Lead Reach AI
            </Button>
          </Link>
          <span className="text-xs text-muted">Version 2026-11-v1 (DRAFT)</span>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div>
            <strong className="font-semibold">DRAFT — REQUIRES LEGAL REVIEW:</strong> This Terms of Service document is an operational draft provided pending formal legal counsel review prior to general commercial release.
          </div>
        </div>

        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
            <FileText size={14} /> User Agreement
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-fg">Terms of Service</h1>
          <p className="text-sm text-muted">
            Please read these terms and our{" "}
            <Link href="/acceptable-use" className="text-primary hover:underline font-medium">
              Acceptable Use Policy
            </Link>{" "}
            carefully before creating an account or sending outreach through Lead Reach AI.
          </p>
        </div>

        <div className="space-y-6 text-xs text-muted leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">1. Acceptance of Terms</h2>
            <p>
              By signing up for or accessing Lead Reach AI, you agree to be bound by these Terms of Service, our{" "}
              <Link href="/acceptable-use" className="text-primary hover:underline">
                Acceptable Use Policy
              </Link>
              , our{" "}
              <Link href="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </Link>
              , and any applicable third-party mailbox provider terms (including Google Workspace and Gmail terms).
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">2. User Legal Responsibility for Electronic Messaging</h2>
            <p>
              You are solely responsible for ensuring that every campaign, message, recipient list, and follow-up sent from your workspace complies with all applicable laws and regulations, including without limitation the U.S. CAN-SPAM Act, the EU and UK General Data Protection Regulation (GDPR / UK GDPR), the UK Privacy and Electronic Communications Regulations (PECR), CASL, and any local direct-marketing laws governing your recipients.
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong>Lawful Basis:</strong> You represent and warrant that you hold a valid lawful basis (such as verified legitimate interest, existing business relationship, or affirmative consent) to process and contact every recipient uploaded or imported into your campaigns.
              </li>
              <li>
                <strong>Postal Address &amp; Working Opt-Out:</strong> Commercial emails should include a valid physical postal address and a clear, working opt-out mechanism wherever applicable law requires. Lead Reach AI provides <code className="font-mono text-fg">{"{{business_address}}"}</code> and <code className="font-mono text-fg">{"{{unsubscribe_url}}"}</code> template variables alongside standard <code className="font-mono text-fg">List-Unsubscribe</code> headers, and you remain responsible for honoring and including required disclosures.
              </li>
              <li>
                <strong>Truthful Sender Identity &amp; Subjects:</strong> You must never falsify header information, use deceptive or misleading subject lines (such as fake &ldquo;Re:&rdquo; or &ldquo;Fwd:&rdquo; prefixes where no prior thread exists), or impersonate third parties.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">3. Prohibited Content &amp; Abuse</h2>
            <p>
              Harassment, threats, illegal content, phishing, malware distribution, deceptive claims, scraped consumer PII harassment, and attempts to bypass platform sending limits or opt-out suppressions are strictly prohibited.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">4. Account &amp; Workspace Suspension or Termination</h2>
            <p>
              Lead Reach AI reserves the right to pause sending, suspend workspaces, restrict mailboxes, or terminate accounts immediately without prior notice if we detect deliverability abuse, excessive bounce or complaint rates, spam activity, legal non-compliance, or violations of these Terms or the Acceptable Use Policy.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">5. Security, Credentials &amp; Editorial Responsibility</h2>
            <p>
              You are responsible for safeguarding your account credentials, App Passwords, and connected API keys, as well as all outreach and social content authored or approved in your workspace. Lead Reach AI encrypts stored tokens and secrets using AES-256-GCM.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">6. Limitation of Liability</h2>
            <p>
              Lead Reach AI is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We do not guarantee uninterrupted access to third-party mail servers or inbox placement, and disclaim liability for any fines, damages, or claims arising from non-compliant campaigns sent by users.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
