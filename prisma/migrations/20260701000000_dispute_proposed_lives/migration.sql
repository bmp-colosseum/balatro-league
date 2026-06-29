-- Disputer's proposed per-game winner's-lives (so accepting a dispute can carry
-- the same per-game detail a normal report does).
ALTER TABLE "Match" ADD COLUMN "disputeProposedLivesG1" INTEGER;
ALTER TABLE "Match" ADD COLUMN "disputeProposedLivesG2" INTEGER;
