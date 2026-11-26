import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert, ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

const AUP_DESCRIPTION =
  "Acceptable Use Policy governing cold outreach compliance (CAN-SPAM, GDPR, PECR), anti-harassment rules, truthful sender identity, and deliverability abuse enforcement on Lead Reach AI.";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description: AUP_DESCRIPTION,
  alternates: {
    canonical: "/acceptable-use",
  },
  openGraph: {
    type: "website",
    url: "/acceptable-use",
    title: "Acceptable Use Policy | Lead Reach AI",
    description: AUP_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Acceptable Use Policy | Lead Reach AI",
    description: AUP_DESCRIPTION,
  },
};

export default function AcceptableUsePolicyPage() {
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
            <strong className="font-semibold">DRAFT — REQUIRES LEGAL REVIEW:</strong> This Acceptable Use Policy is a compliance draft awaiting formal legal counsel review before general commercial release.
          </div>
        </div>

        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
            <ShieldAlert size={14} /> Outreach &amp; Deliverability Standards
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-fg">
            Acceptable Use Policy
          </h1>
          <p className="text-sm text-muted">
            Mandatory rules for all workspaces and mailboxes connected to Lead Reach AI. See also our{" "}
            <Link href="/terms" className="text-primary hover:underline font-medium">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-primary hover:underline font-medium">
              Privacy Policy
            </Link>
            .
          </p>
        </div>

        <div className="space-y-6 text-xs text-muted leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">1. Regulatory Compliance Is Your Responsibility</h2>
            <p>
              You are solely responsible for complying with the U.S. CAN-SPAM Act, EU GDPR, UK GDPR, PECR, CASL, and all other privacy and electronic communications laws applicable to your organization and your recipients.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">2. Lawful Basis &amp; Recipient Transparency</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong>Lawful Basis Required:</strong> Every outreach message requires a valid legal basis (such as documented legitimate business interest for relevant B2B communication or explicit prior consent) before import or dispatch.
              </li>
              <li>
                <strong>Valid Postal Address &amp; Working Opt-Out:</strong> Commercial emails should include a valid physical postal address and a working, honored opt-out method where law requires. Never attempt to hide, obstruct, or ignore unsubscribe requests or suppression entries.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">3. Truthful Identity &amp; Non-Deceptive Messaging</h2>
            <p>
              Sender From names, From addresses, Reply-To headers, and subject lines must accurately represent you and your message. Deceptive subjects (such as fabricated &ldquo;Re:&rdquo; or &ldquo;Fwd:&rdquo; threads), spoofed identities, and misleading urgency or financial claims are prohibited.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">4. Zero Harassment, Illegal Content, or Infrastructure Abuse</h2>
            <p>
              You may not use Lead Reach AI to transmit abusive, harassing, defamatory, fraudulent, adult, malware-laden, or otherwise illegal content, nor may you rotate accounts to evade rate caps or continue contacting recipients who have unsubscribed or bounced.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-fg">5. Suspension &amp; Termination Enforcement</h2>
            <p>
              We actively monitor bounce rates, authentication errors, and abuse indicators to protect email ecosystem health. We may immediately pause workspace sending, lock campaigns, or suspend/terminate accounts for any Acceptable Use Policy violation or deliverability abuse.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

