-- CreateEnum
CREATE TYPE "SpecialistStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SpecialistBindingMode" AS ENUM ('OFF', 'SHADOW', 'ACTIVE');

-- CreateEnum
CREATE TYPE "SpecialistFailurePolicy" AS ENUM ('DEGRADE', 'BLOCK');

-- CreateTable
CREATE TABLE "Specialist" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "status" "SpecialistStatus" NOT NULL DEFAULT 'INACTIVE',
    "promptTemplate" TEXT NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{"version":1,"rules":[]}',
    "contextSources" JSONB NOT NULL DEFAULT '{"version":1,"sources":[]}',
    "outputVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Specialist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSpecialistBinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "specialistId" TEXT NOT NULL,
    "mode" "SpecialistBindingMode" NOT NULL DEFAULT 'OFF',
    "timeoutMs" INTEGER NOT NULL DEFAULT 12000,
    "onFailure" "SpecialistFailurePolicy" NOT NULL DEFAULT 'DEGRADE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSpecialistBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Specialist_tenantId_capability_idx" ON "Specialist"("tenantId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "Specialist_tenantId_key_key" ON "Specialist"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Specialist_id_tenantId_capability_key" ON "Specialist"("id", "tenantId", "capability");

-- CreateIndex
CREATE INDEX "BotSpecialistBinding_specialistId_idx" ON "BotSpecialistBinding"("specialistId");

-- CreateIndex
CREATE INDEX "BotSpecialistBinding_tenantId_idx" ON "BotSpecialistBinding"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BotSpecialistBinding_botConfigId_capability_key" ON "BotSpecialistBinding"("botConfigId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_id_tenantId_key" ON "BotConfig"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_specialistId_fkey" FOREIGN KEY ("specialistId") REFERENCES "Specialist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Specialist" ADD CONSTRAINT "Specialist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSpecialistBinding" ADD CONSTRAINT "BotSpecialistBinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSpecialistBinding" ADD CONSTRAINT "BotSpecialistBinding_botConfigId_tenantId_fkey" FOREIGN KEY ("botConfigId", "tenantId") REFERENCES "BotConfig"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSpecialistBinding" ADD CONSTRAINT "BotSpecialistBinding_specialistId_tenantId_capability_fkey" FOREIGN KEY ("specialistId", "tenantId", "capability") REFERENCES "Specialist"("id", "tenantId", "capability") ON DELETE RESTRICT ON UPDATE CASCADE;

