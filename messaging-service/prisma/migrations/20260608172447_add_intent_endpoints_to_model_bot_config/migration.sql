-- AlterTable
ALTER TABLE "BotConfig" ADD COLUMN     "intentEndpoints" JSONB NOT NULL DEFAULT '{}';
