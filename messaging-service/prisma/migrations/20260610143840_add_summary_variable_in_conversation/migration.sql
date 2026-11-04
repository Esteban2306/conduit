/*
  Warnings:

  - A unique constraint covering the columns `[botConfigId,phoneNumber]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "summary" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_processing_lockedUntil_idx" ON "Conversation"("processing", "lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_botConfigId_phoneNumber_key" ON "Conversation"("botConfigId", "phoneNumber");
