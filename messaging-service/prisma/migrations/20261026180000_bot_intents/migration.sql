-- AlterEnum
ALTER TYPE "AiModelRole" ADD VALUE 'CLASSIFIER';

-- CreateEnum
CREATE TYPE "IntentHandlerKind" AS ENUM ('TEMPLATE', 'TOOL_DIRECT', 'HANDOFF', 'LLM_SLIM');

-- DropTable
DROP TABLE "BotQuickReply";

-- CreateTable
CREATE TABLE "BotIntent" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "handler" "IntentHandlerKind" NOT NULL,
    "mode" "IntentMode" NOT NULL DEFAULT 'SHADOW',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "patterns" JSONB NOT NULL DEFAULT '[]',
    "denyPatterns" JSONB NOT NULL DEFAULT '[]',
    "maxTokens" INTEGER NOT NULL DEFAULT 12,
    "respectsOpenFlow" BOOLEAN NOT NULL DEFAULT false,
    "allowsQuestion" BOOLEAN NOT NULL DEFAULT true,
    "negationOk" BOOLEAN NOT NULL DEFAULT false,
    "fixedConfidence" DOUBLE PRECISION,
    "aiClassifiable" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "variants" JSONB NOT NULL DEFAULT '{}',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "schedule" JSONB,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotIntent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "WhatsAppContact" ADD COLUMN "optedOutAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "BotIntent_botConfigId_key_key" ON "BotIntent"("botConfigId", "key");

-- AddForeignKey
ALTER TABLE "BotIntent" ADD CONSTRAINT "BotIntent_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
