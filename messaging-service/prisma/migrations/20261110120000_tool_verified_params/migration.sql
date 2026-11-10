-- AlterTable
ALTER TABLE "ToolDefinition" ADD COLUMN     "verifiedParams" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "ToolDefinition"
  ADD CONSTRAINT "ToolDefinition_verifiedParams_object_check"
  CHECK (jsonb_typeof("verifiedParams") = 'object');
