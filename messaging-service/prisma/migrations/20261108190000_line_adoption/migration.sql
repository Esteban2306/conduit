CREATE TABLE "WhatsAppConnectionAudit" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "keptConnectionId" TEXT NOT NULL,
  "retiredConnectionId" TEXT NOT NULL,
  "retiredKey" TEXT,
  "counts" JSONB NOT NULL,
  "actor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsAppConnectionAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppConnectionAudit_tenantId_createdAt_idx" ON "WhatsAppConnectionAudit"("tenantId", "createdAt");
CREATE INDEX "WhatsAppContact_address_idx" ON "WhatsAppContact"("address");
