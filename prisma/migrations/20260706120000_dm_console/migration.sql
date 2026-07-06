-- CreateTable
CREATE TABLE "InboundDm" (
    "id" TEXT NOT NULL,
    "discordMessageId" TEXT NOT NULL,
    "authorDiscordId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachmentsJson" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "readAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "repliedBy" TEXT,
    "replyText" TEXT,

    CONSTRAINT "InboundDm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmDelivery" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "batchKind" TEXT,
    "discordId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" INTEGER,
    "errorMsg" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundDm_discordMessageId_key" ON "InboundDm"("discordMessageId");

-- CreateIndex
CREATE INDEX "InboundDm_status_receivedAt_idx" ON "InboundDm"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundDm_authorDiscordId_idx" ON "InboundDm"("authorDiscordId");

-- CreateIndex
CREATE INDEX "DmDelivery_batchId_idx" ON "DmDelivery"("batchId");

-- CreateIndex
CREATE INDEX "DmDelivery_status_sentAt_idx" ON "DmDelivery"("status", "sentAt");

-- CreateIndex
CREATE INDEX "DmDelivery_sentAt_idx" ON "DmDelivery"("sentAt");
