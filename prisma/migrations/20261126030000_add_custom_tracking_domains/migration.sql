-- CreateEnum
CREATE TYPE "TrackingDomainStatus" AS ENUM ('pending', 'verified', 'failed');

-- CreateTable
CREATE TABLE "tracking_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "cname_target" TEXT NOT NULL,
    "status" "TrackingDomainStatus" NOT NULL DEFAULT 'pending',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "last_checked_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_domains_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "outreach_campaigns" ADD COLUMN "tracking_domain_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "tracking_domains_domain_key" ON "tracking_domains"("domain");

-- CreateIndex
CREATE INDEX "tracking_domains_user_id_status_idx" ON "tracking_domains"("user_id", "status");

-- CreateIndex
CREATE INDEX "tracking_domains_user_id_is_default_idx" ON "tracking_domains"("user_id", "is_default");

-- CreateIndex
CREATE INDEX "outreach_campaigns_tracking_domain_id_idx" ON "outreach_campaigns"("tracking_domain_id");

-- AddForeignKey
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_tracking_domain_id_fkey" FOREIGN KEY ("tracking_domain_id") REFERENCES "tracking_domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
