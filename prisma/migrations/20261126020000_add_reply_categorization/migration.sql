-- Add ReplyCategory enum and reply categorization fields on email_messages and campaign_recipients

DO $$ BEGIN
    CREATE TYPE "ReplyCategory" AS ENUM (
        'interested',
        'not_interested',
        'out_of_office',
        'bounce',
        'unsubscribe',
        'other',
        'uncategorized'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "campaign_recipients"
    ADD COLUMN IF NOT EXISTS "reply_category" "ReplyCategory";

ALTER TABLE "email_messages"
    ADD COLUMN IF NOT EXISTS "reply_category" "ReplyCategory",
    ADD COLUMN IF NOT EXISTS "reply_category_confidence" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "reply_category_source" TEXT;

CREATE INDEX IF NOT EXISTS "email_messages_user_id_direction_reply_category_idx"
    ON "email_messages"("user_id", "direction", "reply_category");
