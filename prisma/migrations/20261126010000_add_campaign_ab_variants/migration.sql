-- Add campaign A/B testing variants table and nullable variant_id references (ON DELETE SET NULL)

CREATE TABLE IF NOT EXISTS "campaign_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "step_no" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "subject_template" TEXT,
    "body_template" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_variants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "campaign_variants_campaign_id_step_no_idx" ON "campaign_variants"("campaign_id", "step_no");

ALTER TABLE "campaign_variants"
    ADD CONSTRAINT "campaign_variants_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "outreach_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaign_recipients"
    ADD COLUMN IF NOT EXISTS "variant_id" UUID;

CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_id_variant_id_idx" ON "campaign_recipients"("campaign_id", "variant_id");

ALTER TABLE "campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "campaign_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "email_messages"
    ADD COLUMN IF NOT EXISTS "variant_id" UUID;

CREATE INDEX IF NOT EXISTS "email_messages_variant_id_idx" ON "email_messages"("variant_id");

ALTER TABLE "email_messages"
    ADD CONSTRAINT "email_messages_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "campaign_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tracking_events"
    ADD COLUMN IF NOT EXISTS "variant_id" UUID;

CREATE INDEX IF NOT EXISTS "tracking_events_variant_id_idx" ON "tracking_events"("variant_id");

ALTER TABLE "tracking_events"
    ADD CONSTRAINT "tracking_events_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "campaign_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
