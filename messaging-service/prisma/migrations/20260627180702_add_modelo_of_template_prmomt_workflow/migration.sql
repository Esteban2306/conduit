-- CreateEnum
CREATE TYPE "PromptTemplateType" AS ENUM ('CONVERSATION', 'IMAGE_ANALYSIS', 'SUMMARY', 'SALES', 'APPOINTMENT', 'SUPPORT', 'FALLBACK');

-- CreateEnum
CREATE TYPE "ResponeLenght" AS ENUM ('SHORT', 'MEDIUM', 'LONG');

-- CreateEnum
CREATE TYPE "EmojiLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "BotAiSettings" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL DEFAULT 'Asistente',
    "language" TEXT NOT NULL DEFAULT 'es',
    "tone" TEXT NOT NULL DEFAULT 'Profesional y Amable',
    "personality" TEXT,
    "responseLenght" "ResponeLenght" NOT NULL DEFAULT 'MEDIUM',
    "emojiLevel" "EmojiLevel" NOT NULL DEFAULT 'LOW',
    "allowMarkdown" BOOLEAN NOT NULL DEFAULT false,
    "companyName" TEXT,
    "companyServices" TEXT,
    "businessHours" TEXT,
    "greeting" TEXT,
    "farewell" TEXT,
    "restrictions" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokensConversation" INTEGER NOT NULL DEFAULT 400,
    "maxTokensImage" INTEGER NOT NULL DEFAULT 200,
    "maxTokensSummary" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotPromptTemplate" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "type" "PromptTemplateType" NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotPromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotAiSettings_botConfigId_key" ON "BotAiSettings"("botConfigId");

-- CreateIndex
CREATE INDEX "BotPromptTemplate_botConfigId_type_idx" ON "BotPromptTemplate"("botConfigId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BotPromptTemplate_botConfigId_type_isActive_key" ON "BotPromptTemplate"("botConfigId", "type", "isActive");

-- AddForeignKey
ALTER TABLE "BotAiSettings" ADD CONSTRAINT "BotAiSettings_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotPromptTemplate" ADD CONSTRAINT "BotPromptTemplate_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
