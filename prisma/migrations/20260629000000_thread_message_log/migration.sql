-- CreateTable
CREATE TABLE "ThreadMessage" (
    "id" TEXT NOT NULL,
    "discordMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'match',
    "matchId" TEXT,
    "matchSessionId" TEXT,
    "authorDiscordId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "originalContent" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ThreadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadMessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "bytes" BYTEA,

    CONSTRAINT "ThreadMessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThreadMessage_discordMessageId_key" ON "ThreadMessage"("discordMessageId");

-- CreateIndex
CREATE INDEX "ThreadMessage_threadId_postedAt_idx" ON "ThreadMessage"("threadId", "postedAt");

-- CreateIndex
CREATE INDEX "ThreadMessage_matchId_idx" ON "ThreadMessage"("matchId");

-- CreateIndex
CREATE INDEX "ThreadMessage_capturedAt_idx" ON "ThreadMessage"("capturedAt");

-- CreateIndex
CREATE INDEX "ThreadMessageAttachment_messageId_idx" ON "ThreadMessageAttachment"("messageId");

-- AddForeignKey
ALTER TABLE "ThreadMessageAttachment" ADD CONSTRAINT "ThreadMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ThreadMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
