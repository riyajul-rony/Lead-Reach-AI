-- Additive Phase 6 Task 8 migration: auto-pause signals on email_accounts
ALTER TYPE "EmailAccountStatus" ADD VALUE IF NOT EXISTS 'paused_deliverability';

ALTER TABLE "email_accounts"
  ADD COLUMN IF NOT EXISTS "consecutive_smtp_auth_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deliverability_pause_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "deliverability_paused_at" TIMESTAMPTZ;
