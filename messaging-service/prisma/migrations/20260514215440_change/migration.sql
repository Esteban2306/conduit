/*
  Warnings:

  - The `status` column on the `Message` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `errorType` column on the `MessageAttempt` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `renderedSubject` to the `Message` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `channel` on the `Message` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `description` to the `Template` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `channel` on the `Template` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `updatedAt` to the `WebhookEndpoint` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'RETRYING', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'SMTP');

-- CreateEnum
CREATE TYPE "ErrorType" AS ENUM ('TRANSIENT', 'PERMANENT');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "renderedBody" TEXT,
ADD COLUMN     "renderedSubject" TEXT NOT NULL,
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT true,
DROP COLUMN "channel",
ADD COLUMN     "channel" "MessageChannel" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "MessageStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "MessageAttempt" ADD COLUMN     "errorCode" TEXT,
DROP COLUMN "errorType",
ADD COLUMN     "errorType" "ErrorType";

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "description" TEXT NOT NULL,
DROP COLUMN "channel",
ADD COLUMN     "channel" "MessageChannel" NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "DeadLetterMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "lastErrorCode" TEXT,
    "lastErrorDetail" TEXT,
    "totalAttempts" INTEGER NOT NULL,
    "reviewBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "requeued" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterMessage_messageId_key" ON "DeadLetterMessage"("messageId");

-- AddForeignKey
ALTER TABLE "DeadLetterMessage" ADD CONSTRAINT "DeadLetterMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
