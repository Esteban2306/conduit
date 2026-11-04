/*
  Warnings:

  - A unique constraint covering the columns `[botConfigId,idempotencyKey]` on the table `ExternalDataEvent` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `idempotencyKey` to the `ExternalDataEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExternalDataEvent" ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "mappedCount" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "ExternalDataEvent_botConfigId_idempotencyKey_key" ON "ExternalDataEvent"("botConfigId", "idempotencyKey");
