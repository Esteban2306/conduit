-- CreateEnum
CREATE TYPE "WhatsAppCampaignPolicy" AS ENUM ('INBOUND_ONLY', 'ANY');

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "campaignPolicy" "WhatsAppCampaignPolicy" NOT NULL DEFAULT 'INBOUND_ONLY',
ADD COLUMN     "inboundLookbackDays" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "sessionLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "sessionOwner" TEXT;

-- CreateTable
CREATE TABLE "WhatsAppContact" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lid" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "onWhatsApp" BOOLEAN,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppContact_connectionId_lid_idx" ON "WhatsAppContact"("connectionId", "lid");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppContact_connectionId_address_key" ON "WhatsAppContact"("connectionId", "address");

-- AddForeignKey
ALTER TABLE "WhatsAppContact" ADD CONSTRAINT "WhatsAppContact_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: quien ya escribió al bot conserva el permiso para recibir
-- mensajes del negocio (la política por defecto es INBOUND_ONLY).
INSERT INTO "WhatsAppContact" ("id", "connectionId", "address", "lastInboundAt", "onWhatsApp", "checkedAt", "updatedAt")
SELECT gen_random_uuid()::text, c."lastConnectionId", c."phoneNumber", MAX(m."createdAt"), true, MAX(m."createdAt"), NOW()
FROM "Conversation" c
JOIN "BotMessage" m ON m."conversationId" = c."id" AND m."direction" = 'INBOUND'
JOIN "WhatsAppConnection" w ON w."id" = c."lastConnectionId"
WHERE c."phoneNumber" ~ '^[1-9][0-9]{9,14}$'
GROUP BY c."lastConnectionId", c."phoneNumber"
ON CONFLICT ("connectionId", "address") DO NOTHING;
