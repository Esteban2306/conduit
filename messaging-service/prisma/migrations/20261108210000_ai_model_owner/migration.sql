ALTER TABLE "AiModelConfig" ALTER COLUMN "botConfigId" DROP NOT NULL;

ALTER TABLE "AiModelConfig" ADD COLUMN "specialistId" TEXT;

ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_single_owner_check"
  CHECK (num_nonnulls("botConfigId", "specialistId") = 1);

CREATE INDEX "AiModelConfig_specialistId_role_priority_idx"
  ON "AiModelConfig"("specialistId", "role", "priority");
