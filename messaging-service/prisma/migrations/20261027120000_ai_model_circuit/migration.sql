ALTER TABLE "AiModelConfig"
  ADD COLUMN "credentialInvalidAt" TIMESTAMP(3),
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastErrorType" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

