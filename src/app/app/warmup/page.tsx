import { requireUser } from "@/server/auth/guards";
import { listEmailAccounts } from "@/server/email/account-service";
import { listUserWarmupLogs } from "@/server/email/warmup-pool-service";
import { getWorkerSchedulerStatus } from "@/server/worker/status";
import { WarmupDashboardClient } from "./warmup-dashboard-client";

export const metadata = {
  title: "Email Warm-up — Lead Reach AI",
  description:
    "Manage your private Self Warm-up Pool, daily ramp-up limits, and Gmail App Password connections.",
};

export default async function WarmupPage() {
  const user = await requireUser();

  let initialAccounts: any[] = [];
  let initialLogs: any = {
    items: [],
    total: 0,
    page: 1,
    limit: 15,
    summary: {
      poolCount: 0,
      imapCapableCount: 0,
      poolActive: false,
      sentToday: 0,
      repliedToday: 0,
    },
  };
  let initialError: string | null = null;
  let workerWarning: string | null = null;

  try {
    const [accounts, logsData, workerStatus] = await Promise.all([
      listEmailAccounts(user.id),
      listUserWarmupLogs(user.id, { page: 1, limit: 15 }),
      getWorkerSchedulerStatus(),
    ]);
    initialAccounts = accounts || [];
    if (logsData) initialLogs = logsData;
    workerWarning = workerStatus.warningMessage;
  } catch (err: any) {
    initialError = err?.message || "Failed to load warm-up dashboard data.";
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-16">
      <WarmupDashboardClient
        initialAccounts={initialAccounts}
        initialLogs={initialLogs}
        initialError={initialError}
        workerWarning={workerWarning}
      />
    </div>
  );
}
