/*
  Warnings:

  - You are about to drop the column `reviewBy` on the `DeadLetterMessage` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DeadLetterMessage" DROP COLUMN "reviewBy",
ADD COLUMN     "reviewedBy" TEXT,
ADD CONSTRAINT "DeadLetterMessage_pkey" PRIMARY KEY ("id");
