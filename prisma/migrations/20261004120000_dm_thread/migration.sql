-- AlterTable
ALTER TABLE "InboundDm" ADD COLUMN "repliedByName" TEXT;

-- AlterTable
ALTER TABLE "DmDelivery" ADD COLUMN "content" TEXT,
ADD COLUMN "kind" TEXT,
ADD COLUMN "senderDiscordId" TEXT,
ADD COLUMN "senderName" TEXT,
ADD COLUMN "inReplyToInboundDmId" TEXT;

-- CreateIndex
CREATE INDEX "DmDelivery_discordId_sentAt_idx" ON "DmDelivery"("discordId", "sentAt");
