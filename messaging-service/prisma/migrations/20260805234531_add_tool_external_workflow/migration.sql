-- CreateEnum
CREATE TYPE "ToolInvocationStatus" AS ENUM ('SUCCESS', 'BUSINESS_ERROR', 'TECHNICAL_ERROR');

-- CreateTable
CREATE TABLE "ToolDefinition" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parametersSchema" JSONB NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL DEFAULT 'POST',
    "authHeaderName" TEXT,
    "authSecretEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "toolDefinitionId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestParams" JSONB NOT NULL,
    "status" "ToolInvocationStatus" NOT NULL,
    "responseBody" JSONB,
    "httpStatus" INTEGER,
    "errorDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotEscalationContact" (
    "id" TEXT NOT NULL,
    "botConfigId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "connectionId" TEXT,
    "notifyOn" JSONB NOT NULL DEFAULT '["TECHNICAL_ERROR"]',

    CONSTRAINT "BotEscalationContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolDefinition_botConfigId_isActive_idx" ON "ToolDefinition"("botConfigId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ToolDefinition_botConfigId_name_key" ON "ToolDefinition"("botConfigId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_idempotencyKey_key" ON "ToolInvocation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolInvocation_conversationId_idx" ON "ToolInvocation"("conversationId");

-- CreateIndex
CREATE INDEX "ToolInvocation_toolDefinitionId_status_idx" ON "ToolInvocation"("toolDefinitionId", "status");

-- CreateIndex
CREATE INDEX "BotEscalationContact_botConfigId_idx" ON "BotEscalationContact"("botConfigId");

-- AddForeignKey
ALTER TABLE "ToolDefinition" ADD CONSTRAINT "ToolDefinition_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_toolDefinitionId_fkey" FOREIGN KEY ("toolDefinitionId") REFERENCES "ToolDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotEscalationContact" ADD CONSTRAINT "BotEscalationContact_botConfigId_fkey" FOREIGN KEY ("botConfigId") REFERENCES "BotConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
