-- CreateEnum
CREATE TYPE "VerificationReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Specialist" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "VerificationRecord" ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "reviewDecision" "VerificationReviewDecision",
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "specialistVersion" INTEGER;

-- CreateTable
CREATE TABLE "SpecialistVersion" (
    "id" TEXT NOT NULL,
    "specialistId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptTemplate" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "contextSources" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecialistVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpecialistVersion_tenantId_specialistId_version_idx" ON "SpecialistVersion"("tenantId", "specialistId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistVersion_specialistId_version_key" ON "SpecialistVersion"("specialistId", "version");

-- CreateIndex
CREATE INDEX "VerificationRecord_tenantId_createdAt_idx" ON "VerificationRecord"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationRecord_tenantId_verdict_createdAt_idx" ON "VerificationRecord"("tenantId", "verdict", "createdAt");

-- AddForeignKey
ALTER TABLE "SpecialistVersion" ADD CONSTRAINT "SpecialistVersion_specialistId_tenantId_capability_fkey" FOREIGN KEY ("specialistId", "tenantId", "capability") REFERENCES "Specialist"("id", "tenantId", "capability") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "SpecialistVersion" ADD CONSTRAINT "SpecialistVersion_version_check" CHECK ("version" >= 1);

INSERT INTO "SpecialistVersion" ("id", "specialistId", "tenantId", "capability", "version", "promptTemplate", "rules", "contextSources", "changeNote", "createdBy", "createdAt")
SELECT gen_random_uuid()::text, "id", "tenantId", "capability", 1, "promptTemplate", "rules", "contextSources", 'Versión inicial', NULL, "createdAt"
FROM "Specialist";
