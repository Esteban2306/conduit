-- DropForeignKey
ALTER TABLE "WhatsAppConnection" DROP CONSTRAINT "WhatsAppConnection_botConfigId_fkey";

-- AlterTable
ALTER TABLE "WhatsAppConnection" ALTER COLUMN "botConfigId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "WhatsAppConnection_botConfigId_idx" ON "WhatsAppConnection"("botConfigId");

-- AddForeignKey
ALTER TABLE "WhatsAppConnection" ADD CONSTRAINT "WhatsAppConnection_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
