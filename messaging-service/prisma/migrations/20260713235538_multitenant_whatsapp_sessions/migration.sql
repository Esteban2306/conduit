/*
  Warnings:

  - You are about to drop the column `botConfigId` on the `WhatsAppSession` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[connectionId,type,key]` on the table `WhatsAppSession` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `connectionId` to the `WhatsAppSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `key` to the `WhatsAppSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `WhatsAppSession` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WhatsAppConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'BANNED', 'ERROR');

-- DropForeignKey
ALTER TABLE "WhatsAppSession" DROP CONSTRAINT "WhatsAppSession_botConfigId_fkey";

-- DropIndex
DROP INDEX "WhatsAppSession_botConfigId_key";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "connectionId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "botConfigId" TEXT,
ADD COLUMN     "connectionId" TEXT;

-- AlterTable
ALTER TABLE "WhatsAppSession" DROP COLUMN "botConfigId",
ADD COLUMN     "connectionId" TEXT NOT NULL,
ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "type" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "WhatsAppConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "status" "WhatsAppConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastQr" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppConnection_tenantId_idx" ON "WhatsAppConnection"("tenantId");

-- CreateIndex
CREATE INDEX "WhatsAppConnection_tenantId_status_idx" ON "WhatsAppConnection"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BotMessage_conversationId_createdAt_idx" ON "BotMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_idx" ON "Conversation"("tenantId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_status_idx" ON "Conversation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Message_tenantId_idx" ON "Message"("tenantId");

-- CreateIndex
CREATE INDEX "Message_tenantId_status_idx" ON "Message"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Message_status_scheduledAt_idx" ON "Message"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Template_tenantId_idx" ON "Template"("tenantId");

-- CreateIndex
CREATE INDEX "Template_tenantId_isActive_idx" ON "Template"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_idx" ON "WebhookEndpoint"("tenantId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_isActive_idx" ON "WebhookEndpoint"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "WhatsAppSession_connectionId_idx" ON "WhatsAppSession"("connectionId");

-- CreateIndex
CREATE INDEX "WhatsAppSession_connectionId_type_idx" ON "WhatsAppSession"("connectionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_connectionId_type_key_key" ON "WhatsAppSession"("connectionId", "type", "key");

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConnection" ADD CONSTRAINT "WhatsAppConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConnection" ADD CONSTRAINT "WhatsAppConnection_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
