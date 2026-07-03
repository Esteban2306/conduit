/*
  Warnings:

  - A unique constraint covering the columns `[botConfigId,namespace,key]` on the table `ExternalVariable` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "ExternalVariable_botConfigId_key_idx";

-- DropIndex
DROP INDEX "ExternalVariable_botConfigId_key_key";

-- AlterTable
ALTER TABLE "ExternalVariable" ADD COLUMN     "namespace" TEXT NOT NULL DEFAULT 'vars';

-- CreateTable
CREATE TABLE "WebhookMapping" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookMapping_botConfigId_isActive_idx" ON "WebhookMapping"("botConfigId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookMapping_botConfigId_eventType_key" ON "WebhookMapping"("botConfigId", "eventType");

-- CreateIndex
CREATE INDEX "ExternalVariable_botConfigId_namespace_idx" ON "ExternalVariable"("botConfigId", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalVariable_botConfigId_namespace_key_key" ON "ExternalVariable"("botConfigId", "namespace", "key");

-- AddForeignKey
ALTER TABLE "WebhookMapping" ADD CONSTRAINT "WebhookMapping_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
