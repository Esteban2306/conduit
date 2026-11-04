-- CreateEnum
CREATE TYPE "WhatsAppWarmupLevel" AS ENUM ('FRESH', 'NORMAL', 'TRUSTED');

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "warmupLevel" "WhatsAppWarmupLevel" NOT NULL DEFAULT 'NORMAL';
