-- Per-game lives remaining for the winner (attrition format). Nullable:
-- only the guided /start-match flow captures it; manual reports, admin
-- record-sets, forfeits, and pre-feature games stay NULL. Consumed as the
-- 3+-way-tie standings tiebreaker (net life differential) after head-to-head.
ALTER TABLE "Game" ADD COLUMN "winnerLives" INTEGER;
