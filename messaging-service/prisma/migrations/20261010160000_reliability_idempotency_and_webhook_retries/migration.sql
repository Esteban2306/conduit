-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB;

-- CreateIndex
CREATE INDEX "Message_status_updatedAt_idx" ON "Message"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_idempotencyKey_key" ON "Message"("tenantId", "idempotencyKey");

