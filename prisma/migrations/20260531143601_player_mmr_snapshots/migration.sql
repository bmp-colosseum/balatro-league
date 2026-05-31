-- CreateTable
CREATE TABLE "PlayerMmrSnapshot" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "seasonId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'balatromp.com',
    "rankedMmr" INTEGER,
    "rankedTier" TEXT,
    "totalGames" INTEGER,
    "winRatePct" INTEGER,
    "rawHtml" TEXT,
    "fetchError" TEXT,

    CONSTRAINT "PlayerMmrSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlayerMmrSnapshot_playerId_capturedAt_idx" ON "PlayerMmrSnapshot"("playerId", "capturedAt");

-- CreateIndex
CREATE INDEX "PlayerMmrSnapshot_seasonId_idx" ON "PlayerMmrSnapshot"("seasonId");

-- AddForeignKey
ALTER TABLE "PlayerMmrSnapshot" ADD CONSTRAINT "PlayerMmrSnapshot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
