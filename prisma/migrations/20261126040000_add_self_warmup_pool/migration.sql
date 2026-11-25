-- CreateEnum
CREATE TYPE "WarmupLogStatus" AS ENUM ('sent', 'replied', 'failed');

-- CreateTable
CREATE TABLE "warmup_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "reply_message_id" TEXT,
    "subject" TEXT NOT NULL,
    "status" "WarmupLogStatus" NOT NULL DEFAULT 'sent',
    "replied_at" TIMESTAMPTZ,
    "error" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warmup_logs_user_id_sent_at_idx" ON "warmup_logs"("user_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "warmup_logs_from_account_id_sent_at_idx" ON "warmup_logs"("from_account_id", "sent_at");

-- CreateIndex
CREATE INDEX "warmup_logs_to_account_id_status_idx" ON "warmup_logs"("to_account_id", "status");

-- CreateIndex
CREATE INDEX "warmup_logs_message_id_idx" ON "warmup_logs"("message_id");

-- AddForeignKey
ALTER TABLE "warmup_logs" ADD CONSTRAINT "warmup_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_logs" ADD CONSTRAINT "warmup_logs_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_logs" ADD CONSTRAINT "warmup_logs_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
