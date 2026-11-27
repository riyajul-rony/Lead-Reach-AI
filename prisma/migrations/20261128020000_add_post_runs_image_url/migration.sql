-- Additive Phase 6c migration: separate generated image URL from published post permalink on post_runs.
-- Idempotent and safe: backfills only unpublished rows where external_post_id IS NULL. Never modifies published rows.
ALTER TABLE "post_runs" ADD COLUMN IF NOT EXISTS "image_url" TEXT;

UPDATE "post_runs"
SET
    "image_url" = COALESCE("image_url", "external_url"),
    "external_url" = NULL
WHERE "status" <> 'published'
  AND "external_post_id" IS NULL
  AND "external_url" IS NOT NULL;
