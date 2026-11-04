/*
  Warnings:

  - You are about to drop the column `connectionId` on the `Conversation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "BotMessage" ADD COLUMN     "connectionId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "connectionId",
ADD COLUMN     "lastConnectionId" TEXT;

-- CreateIndex
CREATE INDEX "BotMessage_connectionId_idx" ON "BotMessage"("connectionId");

-- CreateIndex
CREATE INDEX "Conversation_lastConnectionId_idx" ON "Conversation"("lastConnectionId");
