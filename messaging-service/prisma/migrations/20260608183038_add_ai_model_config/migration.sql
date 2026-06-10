/*
  Warnings:

  - You are about to drop the column `aiApikey` on the `BotConfig` table. All the data in the column will be lost.
  - You are about to drop the column `aiBaseUrl` on the `BotConfig` table. All the data in the column will be lost.
  - You are about to drop the column `aiModel` on the `BotConfig` table. All the data in the column will be lost.
  - You are about to drop the column `aiProvider` on the `BotConfig` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AiModelTier" AS ENUM ('FREE', 'PAID');

-- CreateEnum
CREATE TYPE "AiModelRole" AS ENUM ('CONVERSATION', 'IMAGE_ANALYSIS', 'FALLBACK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiProvider" ADD VALUE 'DEEPSEEK';
ALTER TYPE "AiProvider" ADD VALUE 'GROQ';
ALTER TYPE "AiProvider" ADD VALUE 'MISTRAL';

-- AlterTable
ALTER TABLE "BotConfig" DROP COLUMN "aiApikey",
DROP COLUMN "aiBaseUrl",
DROP COLUMN "aiModel",
DROP COLUMN "aiProvider",
ALTER COLUMN "clientApiBaseUrl" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AiModelConfig" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "baseUrl" TEXT,
    "role" "AiModelRole" NOT NULL,
    "tier" "AiModelTier" NOT NULL,
    "priority" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dailyTokenLimit" INTEGER,
    "minuteRequestLimit" INTEGER,
    "tokensUsedToday" INTEGER NOT NULL DEFAULT 0,
    "requestsThisMinute" INTEGER NOT NULL DEFAULT 0,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMinuteResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModelConfig_botConfigId_role_priority_idx" ON "AiModelConfig"("botConfigId", "role", "priority");

-- CreateIndex
CREATE INDEX "AiModelConfig_botConfigId_isActive_idx" ON "AiModelConfig"("botConfigId", "isActive");

-- AddForeignKey
ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
