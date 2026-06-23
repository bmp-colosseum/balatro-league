-- Per-match MMR ledger: each player's hidden MMR before/after this match was applied.
ALTER TABLE "Match" ADD COLUMN "mmrBeforeA" INTEGER;
ALTER TABLE "Match" ADD COLUMN "mmrAfterA" INTEGER;
ALTER TABLE "Match" ADD COLUMN "mmrBeforeB" INTEGER;
ALTER TABLE "Match" ADD COLUMN "mmrAfterB" INTEGER;
