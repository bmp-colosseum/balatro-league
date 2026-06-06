-- Shootouts carry the single tiebreaker game's ban/pick GameState (same
-- JSON shape as a MatchSession game), so a shootout records the deck+stake
-- it was played on and feeds deck/stake stats + profile history like a
-- normal game. Nullable — historical shootouts have no game data.
ALTER TABLE "Shootout" ADD COLUMN "game" TEXT;
