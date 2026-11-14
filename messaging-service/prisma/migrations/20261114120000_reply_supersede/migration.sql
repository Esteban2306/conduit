-- AlterEnum
ALTER TYPE "OutboundReplyStatus" ADD VALUE 'SUPERSEDED';

-- AlterTable
ALTER TABLE "OutboundReply" ADD COLUMN "answeredUntil" TIMESTAMP(3),
ADD COLUMN "supersedable" BOOLEAN NOT NULL DEFAULT true;
