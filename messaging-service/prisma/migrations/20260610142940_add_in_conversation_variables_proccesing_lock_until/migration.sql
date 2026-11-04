-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "processing" BOOLEAN NOT NULL DEFAULT false;
