import { notFound } from "next/navigation";
import type { Prisma } from "@/generated/prisma/client";
import { ShieldCheck } from "lucide-react";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { FollowupEditor, FollowupStep } from "./followup-editor";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = {
  title: "Followup Sequence Builder — Lead Reach AI",
  description: "Automated multi-step followup email sequence with stop-on-reply.",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FollowupSequenceBuilderPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const user = await requireUser();

  if (!UUID_REGEX.test(campaignId)) {
    notFound();
  }

  const campaign = await db.outreach_campaigns.findFirst({
    where: { id: campaignId, user_id: user.id },
    select: {
      id: true,
      name: true,
    } satisfies Prisma.outreach_campaignsSelect,
  });

  if (!campaign) {
    notFound();
  }

  const stepRows = await db.campaign_steps.findMany({
    where: { campaign_id: campaignId },
    orderBy: { step_no: "asc" },
    select: {
      step_no: true,
      delay_days: true,
      mode: true,
      subject_template: true,
      body_template: true,
      ai_instruction: true,
    } satisfies Prisma.campaign_stepsSelect,
  });

  const initialSteps: FollowupStep[] = (stepRows || []).map((s: any) => ({
    step_no: s.step_no,
    delay_days: s.delay_days,
    mode: s.mode === "ai" ? "ai" : "custom",
    subject_template: s.subject_template || "Re: {{previous_subject}}",
    body_template: s.body_template || "",
    ai_instruction: s.ai_instruction || undefined,
  }));
  const initialName = `${campaign.name} Sequence`;

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <PageHeader
        title="Followup Sequence Builder"
        description="Configure automated multi-step followups with guaranteed threading and stop-on-reply protection."
      />

      {/* Safety Notice Banner */}
      <div className="rounded-lg border border-border bg-surface p-4 space-y-2 text-xs">
        <div className="flex items-center gap-2 font-semibold text-accent-green text-sm">
          <ShieldCheck size={16} /> Stop-On-Reply &amp; Threading Enforcement
        </div>
        <p className="text-muted leading-relaxed">
          1. <strong className="text-fg">Stop-On-Reply:</strong> When a recipient replies to any email or unsubscribes, all subsequent steps in this sequence are immediately cancelled.<br />
          2. <strong className="text-fg">Thread Preservation:</strong> Every followup is automatically dispatched using <code className="font-mono text-xs rounded bg-bgSubtle px-1.5 py-0.5 text-fg">In-Reply-To</code> and <code className="font-mono text-xs rounded bg-bgSubtle px-1.5 py-0.5 text-fg">References</code> headers matching the original email thread.
        </p>
      </div>

      <FollowupEditor
        campaignId={campaignId}
        initialSequenceName={initialName}
        initialSteps={initialSteps}
      />
    </div>
  );
}
