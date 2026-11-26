-- Additive Phase 6 migration: adaptive per-account daily limits, history & admin_actions audit table
ALTER TABLE "email_accounts"
  ADD COLUMN IF NOT EXISTS "account_type" TEXT,
  ADD COLUMN IF NOT EXISTS "workspace_tier" TEXT,
  ADD COLUMN IF NOT EXISTS "detected_age_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "message_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "age_source" TEXT,
  ADD COLUMN IF NOT EXISTS "detected_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "ramp_started_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "start_limit_snapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "current_daily_limit" INTEGER,
  ADD COLUMN IF NOT EXISTS "healthy_weeks_completed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_evaluated_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "health_status" TEXT NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS "user_daily_limit" INTEGER,
  ADD COLUMN IF NOT EXISTS "admin_daily_limit_override" INTEGER,
  ADD COLUMN IF NOT EXISTS "rate_limited_until" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "rate_limit_hit_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "account_limit_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "date" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "old_limit" INTEGER NOT NULL,
  "new_limit" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "account_limit_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_limit_history_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_limit_history_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "account_limit_history_account_id_date_idx"
  ON "account_limit_history"("account_id", "date" DESC);

CREATE INDEX IF NOT EXISTS "account_limit_history_user_id_date_idx"
  ON "account_limit_history"("user_id", "date" DESC);

CREATE TABLE IF NOT EXISTS "admin_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_id" UUID,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "target_user_id" UUID,
  "workspace_id" UUID,
  "account_id" UUID,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_actions_action_created_at_idx"
  ON "admin_actions"("action", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "admin_actions_workspace_id_created_at_idx"
  ON "admin_actions"("workspace_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "admin_actions_account_id_created_at_idx"
  ON "admin_actions"("account_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "admin_actions_target_user_id_idx"
  ON "admin_actions"("target_user_id");
