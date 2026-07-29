-- "No ban repeat" companion to noRepeatCombos: a per-session flag that also
-- drops already-BANNED deck+stake combos from every later game's pool. Additive,
-- defaulted, backward-compatible.
ALTER TABLE "MatchSession" ADD COLUMN "noBanRepeat" BOOLEAN NOT NULL DEFAULT false;
