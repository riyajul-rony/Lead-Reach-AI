import Link from "next/link";
import { MessageSquare, Mail, Calendar, ArrowRight, ShieldCheck, Inbox } from "lucide-react";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/pagination";
import { parsePageParam } from "@/lib/query-params";
import { ReplyCategoryControls } from "@/components/outreach/reply-category-controls";
import { VALID_REPLY_CATEGORIES } from "@/server/ai/reply-classifier";

export const metadata = {
  title: "Replies Inbox — Lead Reach AI",
  description: "Track responses from cold outreach leads with stop-on-reply detection.",
};

export default async function RepliesInboxPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string; category?: string }>;
}) {
  const user = await requireUser();
  const userId = user.id;

  const sp = searchParams ? await searchParams : {};
  const currentPage = parsePageParam(sp.page);
  const selectedCategory =
    sp.category && (VALID_REPLY_CATEGORIES as readonly string[]).includes(sp.category)
      ? sp.category
      : "all";
  const pageSize = 50;
  const skip = (currentPage - 1) * pageSize;

  const whereClause: any = {
    user_id: userId,
    direction: "in",
  };
  if (selectedCategory !== "all") {
    whereClause.reply_category = selectedCategory;
  }

  // Fetch incoming replies with pagination and ordered latest first
  const [replies, totalRepliesCount] = await Promise.all([
    db.email_messages.findMany({
      where: whereClause,
      take: pageSize,
      skip,
      orderBy: { sent_at: "desc" },
      select: {
        id: true,
        subject: true,
        snippet: true,
        in_reply_to: true,
        sent_at: true,
        recipient_id: true,
        reply_category: true,
        reply_category_confidence: true,
        reply_category_source: true,
        recipient: {
          select: {
            email: true,
            name: true,
            company: true,
            campaign_id: true,
          },
        },
      },
    }),
    db.email_messages.count({
      where: whereClause,
    }),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <PageHeader
        title="Replies & Inbound Leads"
        description="Incoming responses detected via IMAP. Stop-on-reply protection automatically halts followups."
        actions={
          <Link href="/app/outreach">
            <Button variant="secondary" size="sm">
              View Campaigns
            </Button>
          </Link>
        }
      />

      {/* Category Filter Tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {["all", ...VALID_REPLY_CATEGORIES].map((cat) => (
          <Link
            key={cat}
            href={cat === "all" ? "/app/replies" : `/app/replies?category=${cat}`}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors border ${
              selectedCategory === cat
                ? "bg-primary text-primaryText border-primary"
                : "bg-surface text-muted border-border hover:text-fg"
            }`}
          >
            {cat.replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {replies.length === 0 ? (
        <Card className="p-8">
          <EmptyState
            icon={<Inbox size={20} />}
            title="No Replies Yet"
            description="When prospective leads reply to your cold emails, our background IMAP poller captures them automatically and surfaces them here."
            actionLabel="Launch an Outreach Campaign"
            actionHref="/app/outreach/new"
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-xs text-muted flex items-center justify-between">
            <span>Showing recent responses ({replies.length})</span>
            <span className="flex items-center gap-1.5 text-[var(--badge-success-text)] font-medium">
              <ShieldCheck size={14} /> Stop-On-Reply Active
            </span>
          </div>

          <Card className="divide-y divide-border overflow-hidden transition-colors duration-150 hover:border-borderStrong">
            {replies.map((reply: any) => (
              <div
                key={reply.id}
                className="p-5 hover:bg-surface-hover transition-colors duration-150 flex flex-col sm:flex-row items-start justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-fg truncate">
                      {reply.subject || "Reply to outreach"}
                    </span>
                    <Badge variant="success" size="sm" dot>
                      Replied
                    </Badge>
                    <ReplyCategoryControls
                      messageId={reply.id}
                      initialCategory={reply.reply_category}
                      source={reply.reply_category_source}
                    />
                  </div>

                  {(reply.recipient?.name || reply.recipient?.email || reply.recipient?.company) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      {reply.recipient?.name && (
                        <span className="font-medium text-fg">{reply.recipient.name}</span>
                      )}
                      {reply.recipient?.email && (
                        <span className="text-text-muted font-mono text-[11px]">
                          {reply.recipient.name ? `<${reply.recipient.email}>` : reply.recipient.email}
                        </span>
                      )}
                      {reply.recipient?.company && (
                        <span className="text-text-subtle">• {reply.recipient.company}</span>
                      )}
                    </div>
                  )}

                  <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                    {reply.snippet || "No message body preview"}
                  </p>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted pt-1">
                    <span className="flex items-center gap-1">
                      <Calendar size={12} />
                      {reply.sent_at ? new Date(reply.sent_at).toLocaleString() : "Recently"}
                    </span>
                    {reply.in_reply_to && (
                      <span className="font-mono text-xs text-muted truncate max-w-[200px]">
                        Ref: {reply.in_reply_to}
                      </span>
                    )}
                  </div>
                </div>

                {(reply.recipient?.campaign_id || reply.recipient_id) && (
                  <Link
                    href={reply.recipient?.campaign_id ? `/app/outreach/${reply.recipient.campaign_id}` : "/app/outreach"}
                    className="self-end sm:self-center shrink-0"
                  >
                    <Button variant="ghost" size="sm">
                      View Lead <ArrowRight size={14} className="ml-1" />
                    </Button>
                  </Link>
                )}
              </div>
            ))}
          </Card>

          <Pagination
            currentPage={currentPage}
            totalCount={totalRepliesCount}
            pageSize={pageSize}
            basePath="/app/replies"
            searchParams={sp}
          />
        </div>
      )}
    </div>
  );
}
