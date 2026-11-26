import { NextResponse } from "next/server";
import { getSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export async function GET() {
  const siteUrl = getSiteUrl();

  const body = `# Lead Reach AI

> Multi-tenant B2B lead discovery, cold email outreach, private email self warm-up, and scheduled social publishing platform.

## Overview
Lead Reach AI combines lead extraction, cold email sequencing, reply management, and multi-channel social scheduling inside tenant-isolated workspaces with AES-256-GCM encrypted credentials.

## Core Capabilities (Implemented)
- **Cold Email Outreach**: Multi-account SMTP and Gmail App Password sending engine with a strict 25 emails/hour cap per mailbox, randomized delay jitter, mailbox rotation, custom recipient variables, RFC 8058 one-click unsubscribe (\`/u/[token]\`), and per-tenant suppression lists.
- **Nested Spintax & Campaign A/B Testing**: Nested spintax resolution prior to variable interpolation, plus multi-variant campaign A/B testing with per-variant delivery and reply metrics.
- **Stop-on-Reply & AI Reply Categorization**: Background IMAP poller detects prospect replies, immediately halts remaining follow-up sequence steps, and applies post-stop-on-reply AI categorization with manual category override.
- **Private Self Warm-up Pool**: Automated warm-up exchanges strictly between a user's own connected email accounts (Gmail App Password + IMAP or SMTP/IMAP) with loop guards and per-account daily limits. Not a global third-party warm-up network.
- **Custom Tracking Domains (CTD)**: CNAME-based custom tracking domains verified via DNS lookup, isolated via proxy allowlist to serve only open/click tracking and unsubscribe routes.
- **Lead Discovery & Enrichment**: Cloud extraction across Google Maps, LinkedIn B2B, and Meta Ads Library with email enrichment and CSV / Google Sheets export.
- **Scheduled Social Posts**: Scheduled and direct publishing to connected Facebook Pages, Instagram Professional accounts, and LinkedIn.
- **Plans & Access**: Enforced per-workspace plan limits and quotas with manual plan activation managed by platform administration.

## Key Workflows
1. **Gmail App Password + IMAP Outreach & Warm-up**: Users connect Gmail accounts using an App Password and IMAP access so the worker can dispatch rate-capped outreach or self warm-up messages and poll replies safely.
2. **Private Self Warm-up Pool**: Users enroll two or more of their own connected mailboxes into a private pool; the scheduler pairs accounts within the same tenant, enforces daily caps and loop guards, and exchanges warm-up threads without external pool members.
3. **Custom Tracking Domain (CTD)**: Users add a subdomain CNAME pointing to the platform target, verify DNS, and route open/click pixels and \`/u/[token]\` unsubscribe links through their own domain while all app/admin/API/SEO paths return 404 on CTD hosts.

## Public URLs
- [Home](${siteUrl}/): Platform overview, features, pricing tiers, and FAQ
- [Privacy Policy](${siteUrl}/privacy): Data handling, Google API Limited Use, Meta data usage, and email compliance
- [Terms of Service](${siteUrl}/terms): Platform terms and anti-spam policy
- [User Data Deletion](${siteUrl}/data-deletion): Account and connected social token removal instructions
- [Sitemap](${siteUrl}/sitemap.xml): XML sitemap of public indexable pages

## Non-Indexable / Private Areas
- Authenticated workspace (\`/app/*\`), admin console (\`/admin/*\`), onboarding (\`/onboarding\`), authentication (\`/login\`, \`/signup\`, \`/forgot-password\`, \`/reset-password\`, \`/verify-email\`), unsubscribe tokens (\`/u/*\`), media tokens (\`/media/*\`), and API endpoints (\`/api/*\`) are marked \`noindex, nofollow\` and disallowed in \`robots.txt\`.
`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
