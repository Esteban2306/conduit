/*
  Warnings:

  - The `aiProvider` column on the `BotConfig` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI', 'CUSTOM');

-- AlterTable
ALTER TABLE "BotConfig" DROP COLUMN "aiProvider",
ADD COLUMN     "aiProvider" "AiProvider" NOT NULL DEFAULT 'ANTHROPIC';

-- DropEnum
DROP TYPE "ApiProvider";
