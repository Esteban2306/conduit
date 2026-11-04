-- CreateTable
CREATE TABLE "ExternalIntegration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalIntegration_botConfigId_idx" ON "ExternalIntegration"("botConfigId");

-- CreateIndex
CREATE INDEX "ExternalIntegration_tenantId_idx" ON "ExternalIntegration"("tenantId");

-- AddForeignKey
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
