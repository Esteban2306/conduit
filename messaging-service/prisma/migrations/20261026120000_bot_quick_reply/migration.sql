-- CreateEnum
CREATE TYPE "IntentMode" AS ENUM ('OFF', 'SHADOW', 'ACTIVE');

-- CreateTable
CREATE TABLE "BotQuickReply" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "mode" "IntentMode" NOT NULL DEFAULT 'SHADOW',
    "variants" JSONB NOT NULL DEFAULT '{}',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotQuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotQuickReply_botConfigId_intent_key" ON "BotQuickReply"("botConfigId", "intent");

-- AddForeignKey
ALTER TABLE "BotQuickReply" ADD CONSTRAINT "BotQuickReply_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
