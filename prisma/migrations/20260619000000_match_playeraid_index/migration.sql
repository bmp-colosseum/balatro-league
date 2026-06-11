-- A player's own matches are looked up by (playerAId OR playerBId). playerBId
-- was already indexed; playerAId was not, so the OR couldn't use an index on
-- the A side and fell back to scanning every match in the player's divisions.
-- CreateIndex
CREATE INDEX "Match_playerAId_idx" ON "Match"("playerAId");
