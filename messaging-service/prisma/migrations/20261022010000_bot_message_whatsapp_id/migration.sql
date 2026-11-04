-- AlterTable
ALTER TABLE "BotMessage" ADD COLUMN     "waMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BotMessage_conversationId_waMessageId_key" ON "BotMessage"("conversationId", "waMessageId");

