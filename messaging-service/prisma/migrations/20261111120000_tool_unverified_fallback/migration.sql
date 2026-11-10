-- CreateEnum
CREATE TYPE "ToolVerificationFallback" AS ENUM ('REFUSE', 'PROCEED_UNVERIFIED');

-- AlterTable
ALTER TABLE "ToolDefinition" ADD COLUMN     "onTechnicalFailure" "ToolVerificationFallback" NOT NULL DEFAULT 'REFUSE';

ALTER TABLE "ToolDefinition"
  ADD CONSTRAINT "ToolDefinition_unverified_fallback_check"
  CHECK ("onTechnicalFailure" = 'REFUSE' OR "verificationCapability" IS NOT NULL);
