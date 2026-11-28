-- INF-001: Add missing foreign key indexes safely and idempotently
-- Matches @@index entries in prisma/schema.prisma so prisma migrate reports zero drift.

CREATE INDEX IF NOT EXISTS "email_messages_recipient_id_idx" ON "email_messages"("recipient_id");
CREATE INDEX IF NOT EXISTS "email_accounts_google_connection_id_idx" ON "email_accounts"("google_connection_id");
CREATE INDEX IF NOT EXISTS "followup_sequences_email_account_id_idx" ON "followup_sequences"("email_account_id");
CREATE INDEX IF NOT EXISTS "payments_subscription_id_idx" ON "payments"("subscription_id");
CREATE INDEX IF NOT EXISTS "social_campaigns_social_account_id_idx" ON "social_campaigns"("social_account_id");
CREATE INDEX IF NOT EXISTS "social_campaigns_openai_key_id_idx" ON "social_campaigns"("openai_key_id");
CREATE INDEX IF NOT EXISTS "social_campaigns_workspace_id_idx" ON "social_campaigns"("workspace_id");
CREATE INDEX IF NOT EXISTS "export_jobs_user_id_idx" ON "export_jobs"("user_id");
CREATE INDEX IF NOT EXISTS "export_jobs_search_id_idx" ON "export_jobs"("search_id");
