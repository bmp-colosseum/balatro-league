-- Make Game.deck / Game.stake nullable so a manual web report can capture just
-- the winner's lives (for the standings tiebreaker) without a per-game
-- deck/stake. The guided ban/pick flow still always sets both. Per-game
-- deck/stake stats + traits already skip rows with no GameDeck pool, so the
-- null rows don't pollute aggregates.
ALTER TABLE "Game" ALTER COLUMN "deck" DROP NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "stake" DROP NOT NULL;
