-- AlterTable
ALTER TABLE "BotConfig" ADD COLUMN     "humanTakeoverMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maxMessageAgeMinutes" INTEGER NOT NULL DEFAULT 1440,
ALTER COLUMN "maxHistoryMessages" SET DEFAULT 6;
