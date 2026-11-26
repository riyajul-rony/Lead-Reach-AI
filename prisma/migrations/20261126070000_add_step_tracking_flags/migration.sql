-- Additive Phase 6 migration: per-step open/click tracking flags (null preserves legacy campaigns; new steps default to false)
ALTER TABLE "campaign_steps"
  ADD COLUMN IF NOT EXISTS "tracking_open" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "tracking_click" BOOLEAN;
