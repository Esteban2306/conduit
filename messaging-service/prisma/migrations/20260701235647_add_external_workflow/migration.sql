-- CreateEnum
CREATE TYPE "SourceVariable" AS ENUM ('MANUAL', 'WEBHOOK', 'POLLING');

-- CreateTable
CREATE TABLE "ExternalVariable" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" "SourceVariable" NOT NULL DEFAULT 'MANUAL',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalDataEvent" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalDataEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalVariable_botConfigId_key_idx" ON "ExternalVariable"("botConfigId", "key");

-- CreateIndex
CREATE INDEX "ExternalVariable_expiresAt_idx" ON "ExternalVariable"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalVariable_botConfigId_key_key" ON "ExternalVariable"("botConfigId", "key");

-- CreateIndex
CREATE INDEX "ExternalDataEvent_botConfigId_processedAt_idx" ON "ExternalDataEvent"("botConfigId", "processedAt");

-- CreateIndex
CREATE INDEX "ExternalDataEvent_processedAt_createdAt_idx" ON "ExternalDataEvent"("processedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "ExternalVariable" ADD CONSTRAINT "ExternalVariable_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
