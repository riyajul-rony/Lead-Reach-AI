-- Add trial_exempt flag to users safely (idempotent)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "trial_exempt" BOOLEAN NOT NULL DEFAULT false;
