import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { Plus, ArrowRight, Mail } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { Pagination } from "@/components/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata = {
  title: "Followup Sequences — Lead Reach AI",
  description: "Automate sequence followup emails in the same thread until the prospect replies.",
};

export default async function FollowupOverviewPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string }>;
}) {
  const user = await requireUser();

  const sp = searchParams ? await searchParams : {};
  const parsedPage = parseInt(sp.page || "1", 10);
  const currentPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = 50;
  const skip = (currentPage - 1) * pageSize;

  const [userCampaigns, totalCampaignsCount] = await Promise.all([
    db.outreach_campaigns.findMany({
      where: { user_id: user.id },
      take: pageSize,
      skip,
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        mode: true,
        created_at: true,
      } satisfies Prisma.outreach_campaignsSelect,
    }),
    db.outreach_campaigns.count({ where: { user_id: user.id } }),
  ]);

  const campaignIds = userCampaigns.map((c: { id: string }) => c.id);
  const stepRows =
    campaignIds.length > 0
      ? await db.campaign_steps.findMany({
          where: { campaign_id: { in: campaignIds } },
          select: {
            campaign_id: true,
            step_no: true,
          } satisfies Prisma.campaign_stepsSelect,
        })
      : [];

  const stepCountMap = new Map<string, number>();
  for (const row of stepRows) {
    stepCountMap.set(row.campaign_id, (stepCountMap.get(row.campaign_id) || 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Followup Sequences"
        description="Automatically sends follow-ups in the same email thread with In-Reply-To headers. Stops immediately when a reply is detected."
        actions={
          <Link href="/app/outreach/new">
            <Button variant="primary" size="sm" icon={<Plus size={14} />}>
              New Sequence
            </Button>
          </Link>
        }
      />

      {userCampaigns.length === 0 ? (
        <div className="max-w-lg mx-auto">
          <EmptyState
            icon={<Mail size={20} />}
            title="No Campaigns Configured"
            description="Followup sequences attach directly to outreach campaigns. Create an outreach campaign first to start automating thread followups."
            actionLabel="Create Outreach Campaign"
            actionHref="/app/outreach/new"
            actionIcon={<Plus size={14} />}
          />
        </div>
      ) : (
        <div className="rounded-[8px] border border-border bg-surface p-5 space-y-4 transition-colors duration-150 hover:border-borderStrong">
          <div className="divide-y divide-border">
            {userCampaigns.map((c: any) => {
              const stepCount = stepCountMap.get(c.id) || 0;
              const hasSteps = stepCount > 0;

              return (
                <div
                  key={c.id}
                  className="py-3.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-fg">
                        {`${c.name} Sequence`}
                      </span>
                      {hasSteps ? (
                        <>
                          <Badge variant="success" size="sm" dot>
                            active
                          </Badge>
                          <Badge variant="neutral" size="sm">
                            {stepCount} {stepCount === 1 ? "Step" : "Steps"}
                          </Badge>
                        </>
                      ) : (
                        <Badge variant="neutral" size="sm">
                          No follow-up sequence (0 steps)
                        </Badge>
                      )}
                      <Badge variant="neutral" size="sm" className="text-[10px] uppercase font-mono">
                        {c.mode}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted mt-1">
                      Campaign: <strong className="text-fg">{c.name}</strong> • Status: {c.status}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Link href={`/app/followup/${c.id}`}>
                      <Button variant={hasSteps ? "secondary" : "primary"} size="sm" icon={hasSteps ? <ArrowRight size={13} /> : <Plus size={13} />}>
                        {hasSteps ? "Configure Steps" : "Add Follow-ups"}
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          <Pagination
            currentPage={currentPage}
            totalCount={totalCampaignsCount}
            pageSize={pageSize}
            basePath="/app/followup"
            searchParams={sp}
          />
        </div>
      )}
    </div>
  );
}
