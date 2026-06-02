-- Per-pairing flag: true if any game in this 2-game series was won
-- because the opponent disconnected (via the in-thread "Opponent DC'd"
-- button) instead of a normal winner vote. Doesn't affect standings —
-- audit surface only.

ALTER TABLE "Pairing" ADD COLUMN "hadDc" BOOLEAN NOT NULL DEFAULT false;
