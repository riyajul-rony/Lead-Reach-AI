-- Additive Phase 6 migration: optional workspace business_address setting for {{business_address}}
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "business_address" TEXT;
