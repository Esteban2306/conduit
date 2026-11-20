CREATE TABLE "MutedContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutedContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MutedContact_tenantId_idx" ON "MutedContact"("tenantId");

CREATE UNIQUE INDEX "MutedContact_botConfigId_address_key" ON "MutedContact"("botConfigId", "address");

ALTER TABLE "MutedContact" ADD CONSTRAINT "MutedContact_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
