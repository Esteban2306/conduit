/*
  Warnings:

  - You are about to drop the column `responseLenght` on the `BotAiSettings` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ResponseLength" AS ENUM ('SHORT', 'MEDIUM', 'LONG');

-- AlterTable
ALTER TABLE "BotAiSettings" DROP COLUMN "responseLenght",
ADD COLUMN     "responseLength" "ResponseLength" NOT NULL DEFAULT 'MEDIUM';

-- DropEnum
DROP TYPE "ResponeLenght";
