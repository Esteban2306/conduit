-- CreateEnum
CREATE TYPE "OutboundReplyStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'EXPIRED');

-- DropForeignKey
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT "WebhookDelivery_messageId_fkey";

-- AlterTable
ALTER TABLE "WebhookDelivery" ALTER COLUMN "messageId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "riskLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "riskUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboundReply" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "conversationId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "bubbleCount" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "imageVerified" BOOLEAN,
    "waMessageId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboundReplyStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundReply_idempotencyKey_key" ON "OutboundReply"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboundReply_connectionId_status_nextAttemptAt_idx" ON "OutboundReply"("connectionId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundReply_conversationId_status_idx" ON "OutboundReply"("conversationId", "status");

-- CreateIndex
CREATE INDEX "OutboundReply_groupId_idx" ON "OutboundReply"("groupId");

-- CreateIndex
CREATE INDEX "OutboundReply_status_expiresAt_idx" ON "OutboundReply"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

