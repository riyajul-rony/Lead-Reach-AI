-- Additive Phase 6 Task 9 migration: admin workspace sending pause controls
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "sending_status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "pause_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "paused_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "paused_by" UUID;

CREATE INDEX IF NOT EXISTS "workspaces_sending_status_idx" ON "workspaces"("sending_status");
