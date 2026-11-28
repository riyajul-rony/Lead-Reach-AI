import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { listEmailAccounts } from "@/server/email/account-service";
import { getTrialStatus } from "@/server/billing/trial";
import { EmailAccountsManager, EmailAccount } from "./email-accounts-manager";

export const metadata = {
  title: "Sender Inboxes & Accounts — Lead Reach AI",
  description: "Connect business SMTP/IMAP inboxes for automated outreach rotation.",
};

export default async function EmailAccountsPage() {
  const user = await requireUser();

  const [accountsRaw, trialStatus] = await Promise.all([
    listEmailAccounts(user.id),
    getTrialStatus(user.id).catch(() => null),
  ]);
  const trialExpired = trialStatus?.status === "expired";

  const initialAccounts: EmailAccount[] = accountsRaw.map((a: any) => ({
    ...a,
    hourly_limit: a.hourly_limit || 25,
    daily_limit: a.daily_limit || 50,
    status: a.status || "active",
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Navigation Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-muted">
        <Link href="/app/outreach?tab=accounts" className="hover:underline flex items-center gap-1">
          <ArrowLeft size={14} /> Back to Outreach Overview
        </Link>
      </div>

      <EmailAccountsManager initialAccounts={initialAccounts} trialExpired={trialExpired} />
    </div>
  );
}
