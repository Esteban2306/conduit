ALTER TABLE "WhatsAppConnection" ADD COLUMN "key" TEXT;
ALTER TABLE "BotConfig" ADD COLUMN "key" TEXT;

UPDATE "WhatsAppConnection" c SET "key" = s.k FROM (
  SELECT id, CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS k
  FROM (
    SELECT id, base,
      ROW_NUMBER() OVER (PARTITION BY "tenantId", base ORDER BY "createdAt", id) AS rn
    FROM (
      SELECT id, "tenantId", "createdAt",
        COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'line') AS base
      FROM "WhatsAppConnection"
    ) b
  ) t
) s WHERE c.id = s.id;

UPDATE "BotConfig" c SET "key" = s.k FROM (
  SELECT id, CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS k
  FROM (
    SELECT id, base,
      ROW_NUMBER() OVER (PARTITION BY "tenantId", base ORDER BY "createdAt", id) AS rn
    FROM (
      SELECT id, "tenantId", "createdAt",
        COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'bot') AS base
      FROM "BotConfig"
    ) b
  ) t
) s WHERE c.id = s.id;

CREATE UNIQUE INDEX "WhatsAppConnection_tenantId_key_key" ON "WhatsAppConnection"("tenantId", "key");
CREATE UNIQUE INDEX "BotConfig_tenantId_key_key" ON "BotConfig"("tenantId", "key");
CREATE UNIQUE INDEX "WhatsAppConnection_tenantId_phoneNumber_key" ON "WhatsAppConnection"("tenantId", "phoneNumber");
