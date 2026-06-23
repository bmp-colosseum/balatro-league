-- League queue: one "I'm free" entry per player, until they leave or a match starts.
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QueueEntry_playerId_key" ON "QueueEntry"("playerId");
CREATE INDEX "QueueEntry_seasonId_idx" ON "QueueEntry"("seasonId");
