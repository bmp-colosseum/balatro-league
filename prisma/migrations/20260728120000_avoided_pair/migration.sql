-- A pair of players who must never be scheduled against each other. Global,
-- permanent, symmetric (stored canonical playerAId < playerBId). The graph
-- scheduler drops these edges at build; a division too small to avoid the edge
-- (a full round-robin) surfaces the pair as unavoidable rather than failing.
CREATE TABLE "AvoidedPair" (
    "id" TEXT NOT NULL,
    "playerAId" TEXT NOT NULL,
    "playerBId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "AvoidedPair_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AvoidedPair_playerAId_playerBId_key" ON "AvoidedPair"("playerAId", "playerBId");
CREATE INDEX "AvoidedPair_playerAId_idx" ON "AvoidedPair"("playerAId");
CREATE INDEX "AvoidedPair_playerBId_idx" ON "AvoidedPair"("playerBId");
