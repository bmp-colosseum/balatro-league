-- CreateTable
CREATE TABLE "PlayerTraitsCache" (
    "playerId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traitsJson" TEXT NOT NULL,

    CONSTRAINT "PlayerTraitsCache_pkey" PRIMARY KEY ("playerId")
);

-- AddForeignKey
ALTER TABLE "PlayerTraitsCache" ADD CONSTRAINT "PlayerTraitsCache_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
