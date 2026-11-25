-- ========================================================================
-- Lead Reach AI: Read-Only Backlog & Overdue Counts Inspection Script
-- Safe to run in production prior to enabling schedulers (SCHEDULERS_ENABLED=true).
-- DOES NOT MODIFY OR DELETE ANY DATA.
-- ========================================================================

\echo '========================================================'
\echo '1. OVERDUE SCHEDULED SOCIAL POSTS (post_runs)'
\echo '========================================================'
-- Block 1: Counts scheduled social post_runs already past due (scheduled_for <= NOW()).
-- Splits them into stale (> 24h old, will be marked needs_review) vs safe (< 24h old).
SELECT
  COUNT(*) AS total_due_posts,
  COUNT(CASE WHEN scheduled_for < NOW() - INTERVAL '24 hours' THEN 1 END) AS stale_older_than_24h_will_need_review,
  COUNT(CASE WHEN scheduled_for >= NOW() - INTERVAL '24 hours' AND scheduled_for <= NOW() THEN 1 END) AS safe_due_within_24h,
  MIN(scheduled_for) AS oldest_scheduled_for
FROM post_runs
WHERE status = 'scheduled' AND scheduled_for <= NOW();

\echo '========================================================'
\echo '2. SOCIAL POST RUNS BREAKDOWN BY STATUS'
\echo '========================================================'
-- Block 2: Totals of all rows in post_runs grouped by PostRunStatus enum.
SELECT
  status,
  COUNT(*) AS total_count
FROM post_runs
GROUP BY status
ORDER BY total_count DESC;

\echo '========================================================'
\echo '3. OVERDUE EMAIL FOLLOW-UPS (campaign_recipients)'
\echo '========================================================'
-- Block 3: Counts sent recipients with a due follow-up (next_followup_at <= NOW()).
-- Splits overdue (> 24h, will be marked needs_review) vs safe (< 24h, eligible on next tick).
SELECT
  COUNT(*) AS total_due_followups,
  COUNT(CASE WHEN next_followup_at < NOW() - INTERVAL '24 hours' THEN 1 END) AS stale_older_than_24h_will_need_review,
  COUNT(CASE WHEN next_followup_at >= NOW() - INTERVAL '24 hours' AND next_followup_at <= NOW() THEN 1 END) AS safe_due_within_24h,
  MIN(next_followup_at) AS oldest_due_followup_at
FROM campaign_recipients
WHERE status = 'sent' AND next_followup_at IS NOT NULL AND next_followup_at <= NOW();

\echo '========================================================'
\echo '4. QUEUED FIRST EMAIL DISPATCHES (campaign_recipients)'
\echo '========================================================'
-- Block 4: Counts unsent queued recipients split by stale threshold (created_at < NOW() - 24h).
SELECT
  COUNT(*) AS total_queued_recipients,
  COUNT(CASE WHEN created_at < NOW() - INTERVAL '24 hours' THEN 1 END) AS queued_older_than_24h_will_need_review,
  COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) AS safe_queued_within_24h,
  MIN(created_at) AS oldest_queued_created_at
FROM campaign_recipients
WHERE status = 'queued';

\echo '========================================================'
\echo '5. CAMPAIGN RECIPIENTS BREAKDOWN BY STATUS'
\echo '========================================================'
-- Block 5: Totals of all campaign_recipients rows grouped by RecipientStatus enum.
SELECT
  status,
  COUNT(*) AS total_count
FROM campaign_recipients
GROUP BY status
ORDER BY total_count DESC;

\echo '========================================================'
\echo '6. RUNNING / ACTIVE CAMPAIGNS SUMMARY'
\echo '========================================================'
-- Block 6: Overview of social_campaigns and outreach_campaigns counts by status.
SELECT
  'social' AS campaign_type,
  status::text AS status,
  COUNT(*) AS count
FROM social_campaigns
GROUP BY status
UNION ALL
SELECT
  'email_outreach' AS campaign_type,
  status::text AS status,
  COUNT(*) AS count
FROM outreach_campaigns
GROUP BY status;

\echo '========================================================'
\echo 'Backlog check completed successfully.'
\echo '========================================================'
