-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ApiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'WAITING_PAYMENT', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'INACTIVE',
    "aiProvider" "ApiProvider" NOT NULL DEFAULT 'ANTHROPIC',
    "aiModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "apiApikey" TEXT NOT NULL,
    "aiBaseUrl" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "imageAnalysisEnabled" BOOLEAN NOT NULL DEFAULT false,
    "clientApiBaseUrl" TEXT NOT NULL,
    "clientApiHeaders" JSONB NOT NULL DEFAULT '{}',
    "maxHistoryMessages" INTEGER NOT NULL DEFAULT 10,
    "conversationTimeoutMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "botConfigId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "context" JSONB NOT NULL DEFAULT '{}',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "imageVerfied" BOOLEAN NOT NULL,
    "proccessedBy" TEXT NOT NULL DEFAULT 'bot',
    "intent" TEXT NOT NULL,
    "tokenUsed" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_phoneNumber_idx" ON "Conversation"("phoneNumber");

-- CreateIndex
CREATE INDEX "Conversation_botConfigId_status_idx" ON "Conversation"("botConfigId", "status");

-- CreateIndex
CREATE INDEX "BotMessage_conversationId_idx" ON "BotMessage"("conversationId");

-- AddForeignKey
ALTER TABLE "BotConfig" ADD CONSTRAINT "BotConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
