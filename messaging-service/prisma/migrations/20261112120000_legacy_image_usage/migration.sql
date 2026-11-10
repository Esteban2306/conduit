-- CreateTable
CREATE TABLE "LegacyImageUsage" (
    "tenantId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyImageUsage_pkey" PRIMARY KEY ("botConfigId","day")
);

-- CreateIndex
CREATE INDEX "LegacyImageUsage_tenantId_day_idx" ON "LegacyImageUsage"("tenantId", "day");
