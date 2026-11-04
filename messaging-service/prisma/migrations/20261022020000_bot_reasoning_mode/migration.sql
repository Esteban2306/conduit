-- CreateEnum
CREATE TYPE "ReasoningMode" AS ENUM ('AUTO', 'LOW', 'OFF');

-- AlterTable
ALTER TABLE "BotAiSettings" ADD COLUMN     "reasoningMode" "ReasoningMode" NOT NULL DEFAULT 'AUTO';

