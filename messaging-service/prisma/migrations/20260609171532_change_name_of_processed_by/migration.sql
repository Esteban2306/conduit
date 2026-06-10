/*
  Warnings:

  - You are about to drop the column `proccessedBy` on the `BotMessage` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[botConfigId]` on the table `WhatsAppSession` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "BotMessage" DROP COLUMN "proccessedBy",
ADD COLUMN     "processedBy" TEXT NOT NULL DEFAULT 'bot';

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN     "botConfigId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_botConfigId_key" ON "WhatsAppSession"("botConfigId");

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
