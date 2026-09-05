-- AlterTable
ALTER TABLE "ToolDefinition" ADD COLUMN     "imageParamName" TEXT DEFAULT 'imageBase64',
ADD COLUMN     "maxImageSizeBytes" INTEGER DEFAULT 8388608,
ADD COLUMN     "requiresImageAttachment" BOOLEAN NOT NULL DEFAULT false;
