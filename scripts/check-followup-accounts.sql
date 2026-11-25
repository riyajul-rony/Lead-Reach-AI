-- ========================================================================
-- Lead Reach AI: Read-Only Follow-up Accounts & Recipient Status Audit
-- Validated against prisma/schema.prisma. Safe to run in production.
-- DOES NOT MODIFY DATA AND SELECTS NO LEAD EMAILS OR PERSONAL DATA.
-- ========================================================================

\echo '========================================================'
\echo '1. INCOMPLETE CAMPAIGNS WITH FOLLOW-UPS & REPLY DETECTION'
\echo '========================================================'
-- Block 1: Lists every outreach_campaign not completed/cancelled/archived that has follow-up steps
-- (in campaign_steps or followup_sequences/followup_steps), its assigned sender account(s),
-- whether each account has working reply detection per accountHasWorkingReplyDetection() logic
-- (status = 'active' AND (reply_inbox_account_id IS NOT NULL OR direct IMAP configured)),
-- and aggregated recipient counts per status (no lead PII).
WITH followup_campaigns AS (
  SELECT oc.id, oc.name, oc.status, oc.source_ref
  FROM outreach_campaigns oc
  WHERE oc.status::text NOT IN ('completed', 'cancelled', 'archived')
    AND (
      EXISTS (SELECT 1 FROM campaign_steps cs WHERE cs.campaign_id = oc.id)
      OR EXISTS (
        SELECT 1
        FROM followup_sequences fs
        JOIN followup_steps fst ON fst.sequence_id = fs.id
        WHERE fs.campaign_id = oc.id
      )
    )
),
campaign_account_links AS (
  SELECT DISTINCT oca.campaign_id, oca.email_account_id
  FROM outreach_campaign_accounts oca
  JOIN followup_campaigns fc ON fc.id = oca.campaign_id
  UNION
  SELECT DISTINCT fs.campaign_id, fs.email_account_id
  FROM followup_sequences fs
  JOIN followup_campaigns fc ON fc.id = fs.campaign_id
  WHERE fs.email_account_id IS NOT NULL
  UNION
  SELECT DISTINCT fc.id AS campaign_id, elem::uuid AS email_account_id
  FROM followup_campaigns fc
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN fc.source_ref IS NOT NULL
        AND jsonb_typeof(fc.source_ref::jsonb -> 'sender_account_ids') = 'array'
      THEN fc.source_ref::jsonb -> 'sender_account_ids'
      ELSE '[]'::jsonb
    END
  ) AS elem
  WHERE elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
recipient_stats AS (
  SELECT
    cr.campaign_id,
    COUNT(*) AS total_recipients,
    COUNT(*) FILTER (WHERE cr.status = 'queued') AS queued_count,
    COUNT(*) FILTER (WHERE cr.status = 'sending') AS sending_count,
    COUNT(*) FILTER (WHERE cr.status = 'sent') AS sent_count,
    COUNT(*) FILTER (WHERE cr.status = 'needs_review') AS needs_review_count,
    COUNT(*) FILTER (WHERE cr.status = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE cr.status = 'replied') AS replied_count,
    COUNT(*) FILTER (WHERE cr.status = 'bounced') AS bounced_count,
    COUNT(*) FILTER (WHERE cr.status = 'unsubscribed') AS unsubscribed_count,
    COUNT(*) FILTER (WHERE cr.status = 'skipped') AS skipped_count,
    COUNT(*) FILTER (WHERE cr.status = 'failed_generation') AS failed_generation_count
  FROM campaign_recipients cr
  JOIN followup_campaigns fc ON fc.id = cr.campaign_id
  GROUP BY cr.campaign_id
)
SELECT
  fc.id AS campaign_id,
  fc.name AS campaign_name,
  fc.status AS campaign_status,
  ea.label AS account_label,
  ea.provider AS account_provider,
  ea.from_email AS account_from_email,
  ea.status AS account_status,
  CASE
    WHEN ea.id IS NULL THEN false
    WHEN ea.status = 'active'
      AND (
        ea.reply_inbox_account_id IS NOT NULL
        OR (
          ea.imap_host IS NOT NULL
          AND BTRIM(ea.imap_host) <> ''
          AND (ea.imap_password_enc IS NOT NULL OR ea.provider = 'smtp')
        )
      )
    THEN true
    ELSE false
  END AS has_working_reply_detection,
  COALESCE(rs.total_recipients, 0) AS total_recipients,
  COALESCE(rs.queued_count, 0) AS queued_count,
  COALESCE(rs.sending_count, 0) AS sending_count,
  COALESCE(rs.sent_count, 0) AS sent_count,
  COALESCE(rs.needs_review_count, 0) AS needs_review_count,
  COALESCE(rs.failed_count, 0) AS failed_count,
  COALESCE(rs.replied_count, 0) AS replied_count,
  COALESCE(rs.bounced_count, 0) AS bounced_count,
  COALESCE(rs.unsubscribed_count, 0) AS unsubscribed_count,
  COALESCE(rs.skipped_count, 0) AS skipped_count,
  COALESCE(rs.failed_generation_count, 0) AS failed_generation_count
FROM followup_campaigns fc
LEFT JOIN campaign_account_links cal ON cal.campaign_id = fc.id
LEFT JOIN email_accounts ea ON ea.id = cal.email_account_id
LEFT JOIN recipient_stats rs ON rs.campaign_id = fc.id
ORDER BY fc.name, ea.from_email;

\echo '========================================================'
\echo '2. GMAIL_API / OAUTH-ONLY ACCOUNTS USED BY FOLLOW-UP CAMPAIGNS'
\echo '========================================================'
-- Block 2: Lists gmail_api / OAuth-only sender accounts (no IMAP host and no reply_inbox_account_id)
-- referenced by any incomplete campaign that has follow-up steps.
WITH followup_campaigns AS (
  SELECT oc.id, oc.name, oc.status, oc.source_ref
  FROM outreach_campaigns oc
  WHERE oc.status::text NOT IN ('completed', 'cancelled', 'archived')
    AND (
      EXISTS (SELECT 1 FROM campaign_steps cs WHERE cs.campaign_id = oc.id)
      OR EXISTS (
        SELECT 1
        FROM followup_sequences fs
        JOIN followup_steps fst ON fst.sequence_id = fs.id
        WHERE fs.campaign_id = oc.id
      )
    )
),
campaign_account_links AS (
  SELECT DISTINCT oca.campaign_id, oca.email_account_id
  FROM outreach_campaign_accounts oca
  JOIN followup_campaigns fc ON fc.id = oca.campaign_id
  UNION
  SELECT DISTINCT fs.campaign_id, fs.email_account_id
  FROM followup_sequences fs
  JOIN followup_campaigns fc ON fc.id = fs.campaign_id
  WHERE fs.email_account_id IS NOT NULL
  UNION
  SELECT DISTINCT fc.id AS campaign_id, elem::uuid AS email_account_id
  FROM followup_campaigns fc
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN fc.source_ref IS NOT NULL
        AND jsonb_typeof(fc.source_ref::jsonb -> 'sender_account_ids') = 'array'
      THEN fc.source_ref::jsonb -> 'sender_account_ids'
      ELSE '[]'::jsonb
    END
  ) AS elem
  WHERE elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
SELECT
  ea.id AS account_id,
  ea.label AS account_label,
  ea.from_email,
  ea.provider,
  ea.status AS account_status,
  ea.oauth_scopes,
  (ea.imap_host IS NOT NULL AND BTRIM(ea.imap_host) <> '') AS has_imap_host,
  (ea.reply_inbox_account_id IS NOT NULL) AS has_linked_reply_inbox,
  COUNT(DISTINCT fc.id) AS affected_campaigns_count,
  STRING_AGG(DISTINCT fc.name, ', ' ORDER BY fc.name) AS affected_campaign_names
FROM email_accounts ea
JOIN campaign_account_links cal ON cal.email_account_id = ea.id
JOIN followup_campaigns fc ON fc.id = cal.campaign_id
WHERE ea.provider = 'gmail_api'
  AND (ea.imap_host IS NULL OR BTRIM(ea.imap_host) = '')
  AND ea.reply_inbox_account_id IS NULL
GROUP BY ea.id, ea.label, ea.from_email, ea.provider, ea.status, ea.oauth_scopes
ORDER BY affected_campaigns_count DESC, ea.from_email;

\echo '========================================================'
\echo '3. RECIPIENTS IN SENDING OR NEEDS_REVIEW BY CAMPAIGN'
\echo '========================================================'
-- Block 3: Counts recipients currently in 'sending' or 'needs_review' grouped by campaign
-- (no lead emails or personal data).
SELECT
  oc.id AS campaign_id,
  oc.name AS campaign_name,
  oc.status AS campaign_status,
  cr.status AS recipient_status,
  COUNT(*) AS recipient_count,
  MIN(cr.sending_started_at) AS oldest_sending_started_at,
  MIN(cr.next_followup_at) AS oldest_next_followup_at
FROM campaign_recipients cr
JOIN outreach_campaigns oc ON oc.id = cr.campaign_id
WHERE cr.status IN ('sending', 'needs_review')
GROUP BY oc.id, oc.name, oc.status, cr.status
ORDER BY recipient_count DESC, oc.name, cr.status;
