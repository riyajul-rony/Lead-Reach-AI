export interface FAQItem {
  question: string;
  answer: string;
}

export const LANDING_FAQS: readonly FAQItem[] = [
  {
    question: "How does Lead Reach AI protect cold email deliverability?",
    answer:
      "Lead Reach AI enforces a 25 emails/hour cap per sending mailbox, applies randomized delay jitter between dispatches, supports multi-mailbox rotation, and includes RFC 8058 one-click unsubscribe links with automatic per-tenant suppression lists.",
  },
  {
    question: "Does Lead Reach AI support spintax and A/B testing in outreach campaigns?",
    answer:
      "Yes. Campaigns support nested spintax syntax resolved before recipient variable rendering, as well as multi-variant A/B testing so you can compare delivery and reply metrics across subject and body variants.",
  },
  {
    question: "How do automated Stop-on-Reply and AI Reply Categorization work?",
    answer:
      "A background IMAP poller monitors connected sending or reply inboxes. When a prospect replies, remaining follow-up steps for that recipient stop immediately, and AI reply categorization classifies the response with full manual override in your inbox.",
  },
  {
    question: "How does the Private Self Warm-up Pool work?",
    answer:
      "The Private Self Warm-up Pool sends and replies to warm-up messages strictly between your own connected email accounts (via Gmail App Password + IMAP or SMTP/IMAP) with loop guards and daily limit enforcement. It never connects your mailboxes to an external third-party warm-up network.",
  },
  {
    question: "Can I use a Custom Tracking Domain (CNAME) for outreach links?",
    answer:
      "Yes. You can configure a custom CNAME subdomain for open tracking, click tracking, and unsubscribe URLs. After DNS verification, Lead Reach AI restricts custom tracking hostnames strictly to tracking and unsubscribe paths.",
  },
  {
    question: "Which lead sources, social platforms, and security controls are included?",
    answer:
      "Lead Reach AI supports lead discovery across Google Maps, LinkedIn B2B, and Meta Ads Library with CSV and Google Sheets export, scheduled social posting to Facebook Pages, Instagram Professional accounts, and LinkedIn, plus AES-256-GCM credential encryption and strict multi-tenant data isolation.",
  },
  {
    question: "How are workspace plans and billing activated?",
    answer:
      "Each workspace has enforced plan quotas and limits for leads, mailboxes, campaigns, and social accounts. Plan upgrades and billing activations are handled manually by platform administration rather than automated self-serve card checkout.",
  },
];
