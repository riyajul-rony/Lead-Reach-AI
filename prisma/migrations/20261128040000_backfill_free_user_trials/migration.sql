-- Idempotent backfill: give existing free-plan standard users a 14-day trial starting at deploy time.
-- Paid users, staff/admin roles, trial-exempt users, and users who already have any subscription row are untouched.

INSERT INTO "plans" (
  "name",
  "slug",
  "monthly_price",
  "yearly_price",
  "currency",
  "is_active",
  "features",
  "monthly_leads",
  "monthly_social_posts",
  "monthly_outreach_emails",
  "daily_outreach_emails",
  "monthly_ai_outreach_emails",
  "max_social_accounts",
  "max_email_accounts",
  "max_campaigns"
)
SELECT
  'Free Tier',
  'free',
  0,
  0,
  'USD',
  true,
  ARRAY['100 Leads / month', '30 Social Posts / month', '100 Outreach Emails / month', '1 Email Inbox', '2 Social Accounts', '2 Active Campaigns'],
  100,
  30,
  100,
  50,
  50,
  2,
  1,
  2
WHERE NOT EXISTS (
  SELECT 1 FROM "plans" WHERE "slug" = 'free'
);

UPDATE "users" u
SET "plan_id" = p."id"
FROM "plans" p
WHERE p."slug" = 'free'
  AND u."plan" = 'free'
  AND u."plan_id" IS NULL;

INSERT INTO "subscriptions" (
  "id",
  "user_id",
  "plan_id",
  "status",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "provider",
  "provider_subscription_id",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  u."id",
  p."id",
  'trialing'::"SubscriptionStatus",
  NOW(),
  NOW() + INTERVAL '14 days',
  false,
  'trial',
  'trial_' || u."id"::text,
  NOW(),
  NOW()
FROM "users" u
CROSS JOIN LATERAL (
  SELECT "id" FROM "plans" WHERE "slug" = 'free' LIMIT 1
) p
WHERE u."role" = 'user'::"UserRole"
  AND u."plan" = 'free'
  AND COALESCE(u."trial_exempt", false) = false
  AND NOT EXISTS (
    SELECT 1 FROM "subscriptions" s WHERE s."user_id" = u."id"
  );
