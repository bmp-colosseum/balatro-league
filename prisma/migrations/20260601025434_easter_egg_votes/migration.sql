-- CreateTable
CREATE TABLE "EasterEggVote" (
    "id" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "voterDiscordId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EasterEggVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EasterEggVote_targetKey_side_idx" ON "EasterEggVote"("targetKey", "side");

-- CreateIndex
CREATE UNIQUE INDEX "EasterEggVote_targetKey_voterDiscordId_key" ON "EasterEggVote"("targetKey", "voterDiscordId");
