-- AlterTable
ALTER TABLE "BotSpecialistBinding" ADD COLUMN     "blockMessage" TEXT;

-- AlterTable
ALTER TABLE "Specialist" ADD COLUMN     "outputSchema" JSONB NOT NULL DEFAULT '{"version":1,"variables":[],"uniqueBy":[]}';

-- AlterTable
ALTER TABLE "SpecialistVersion" ADD COLUMN     "outputSchema" JSONB NOT NULL DEFAULT '{"version":1,"variables":[],"uniqueBy":[]}';

UPDATE "Specialist"
SET "outputSchema" = '{"version":1,"variables":[{"name":"amount","type":"number","min":0,"max":1000000000000,"tolerance":0.005,"label":"monto","description":"Valor total del documento, solo el número"},{"name":"currency","type":"string","maxLength":3,"exposeToBot":true,"label":"moneda","description":"Código ISO de 3 letras mayúsculas"},{"name":"date","type":"date","label":"fecha","description":"Fecha del documento en formato YYYY-MM-DD"},{"name":"reference","type":"string","maxLength":64,"identityMinLength":5,"label":"referencia","description":"Número o código de referencia del documento"},{"name":"recipient","type":"string","maxLength":120,"label":"destinatario","description":"Nombre de quien recibe"}],"uniqueBy":["reference","amount","date"]}'::jsonb
WHERE "outputSchema" = '{"version":1,"variables":[],"uniqueBy":[]}'::jsonb;

UPDATE "SpecialistVersion"
SET "outputSchema" = '{"version":1,"variables":[{"name":"amount","type":"number","min":0,"max":1000000000000,"tolerance":0.005,"label":"monto","description":"Valor total del documento, solo el número"},{"name":"currency","type":"string","maxLength":3,"exposeToBot":true,"label":"moneda","description":"Código ISO de 3 letras mayúsculas"},{"name":"date","type":"date","label":"fecha","description":"Fecha del documento en formato YYYY-MM-DD"},{"name":"reference","type":"string","maxLength":64,"identityMinLength":5,"label":"referencia","description":"Número o código de referencia del documento"},{"name":"recipient","type":"string","maxLength":120,"label":"destinatario","description":"Nombre de quien recibe"}],"uniqueBy":["reference","amount","date"]}'::jsonb
WHERE "outputSchema" = '{"version":1,"variables":[],"uniqueBy":[]}'::jsonb;

ALTER TABLE "Specialist" ADD CONSTRAINT "Specialist_outputSchema_check" CHECK (jsonb_typeof("outputSchema") = 'object');

ALTER TABLE "SpecialistVersion" ADD CONSTRAINT "SpecialistVersion_outputSchema_check" CHECK (jsonb_typeof("outputSchema") = 'object');
