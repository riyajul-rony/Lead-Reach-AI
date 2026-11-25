-- CreateIndex safely for reply matching
CREATE INDEX IF NOT EXISTS "campaign_recipients_thread_message_id_idx" ON "campaign_recipients"("thread_message_id");
