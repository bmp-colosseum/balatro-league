-- Activity scan: per-run record of who's posted in the league's channels.
CREATE TABLE "ActivityScan" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "channelsTotal" INTEGER NOT NULL DEFAULT 0,
    "channelsDone" INTEGER NOT NULL DEFAULT 0,
    "messagesScanned" INTEGER NOT NULL DEFAULT 0,
    "lastPostByDiscordId" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    CONSTRAINT "ActivityScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityScan_seasonId_startedAt_idx" ON "ActivityScan"("seasonId", "startedAt");
