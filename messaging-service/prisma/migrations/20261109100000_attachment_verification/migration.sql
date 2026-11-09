-- AlterTable
ALTER TABLE "ToolDefinition" ADD COLUMN     "acceptedVerdicts" "VerificationVerdict"[] DEFAULT ARRAY[]::"VerificationVerdict"[],
ADD COLUMN     "verificationCapability" TEXT,
ADD COLUMN     "verificationParamName" TEXT;

-- AlterTable
ALTER TABLE "VerificationRecord" ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "hashVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "VerificationRecord_tenantId_fingerprint_idx" ON "VerificationRecord"("tenantId", "fingerprint");

ALTER TABLE "ToolDefinition" ADD CONSTRAINT "ToolDefinition_verification_check"
  CHECK ("verificationCapability" IS NULL
         OR ("requiresImageAttachment" AND COALESCE(cardinality("acceptedVerdicts"), 0) > 0));
