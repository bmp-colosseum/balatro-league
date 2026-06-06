-- DropForeignKey
ALTER TABLE "Ban" DROP CONSTRAINT "Ban_gameId_fkey";

-- DropTable
DROP TABLE "Ban";

-- CreateTable
CREATE TABLE "GameDeck" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "poolIdx" INTEGER NOT NULL,
    "deck" TEXT NOT NULL,
    "stake" TEXT NOT NULL,
    "picked" BOOLEAN NOT NULL DEFAULT false,
    "banOrdinal" INTEGER,
    "bannedById" TEXT,

    CONSTRAINT "GameDeck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameDeck_gameId_idx" ON "GameDeck"("gameId");

-- CreateIndex
CREATE INDEX "GameDeck_deck_idx" ON "GameDeck"("deck");

-- CreateIndex
CREATE INDEX "GameDeck_stake_idx" ON "GameDeck"("stake");

-- CreateIndex
CREATE UNIQUE INDEX "GameDeck_gameId_poolIdx_key" ON "GameDeck"("gameId", "poolIdx");

-- AddForeignKey
ALTER TABLE "GameDeck" ADD CONSTRAINT "GameDeck_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

