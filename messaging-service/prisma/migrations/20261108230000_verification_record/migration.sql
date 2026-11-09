-- CreateEnum
CREATE TYPE "VerificationVerdict" AS ENUM ('VALID', 'INVALID', 'NEEDS_REVIEW', 'UNREADABLE', 'NOT_APPLICABLE', 'ERROR');

-- CreateTable
CREATE TABLE "VerificationRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "specialistId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "verdict" "VerificationVerdict" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "reasonCodes" TEXT[],
    "modelUsed" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "mode" "SpecialistBindingMode" NOT NULL,
    "comparison" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationRecord_tenantId_subjectHash_idx" ON "VerificationRecord"("tenantId", "subjectHash");

-- CreateIndex
CREATE INDEX "VerificationRecord_tenantId_conversationId_createdAt_idx" ON "VerificationRecord"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationRecord_specialistId_createdAt_idx" ON "VerificationRecord"("specialistId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationRecord_expiresAt_idx" ON "VerificationRecord"("expiresAt");

-- AddForeignKey
ALTER TABLE "VerificationRecord" ADD CONSTRAINT "VerificationRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRecord" ADD CONSTRAINT "VerificationRecord_specialistId_tenantId_capability_fkey" FOREIGN KEY ("specialistId", "tenantId", "capability") REFERENCES "Specialist"("id", "tenantId", "capability") ON DELETE RESTRICT ON UPDATE CASCADE;

