-- Per-preset deck/stake weighting + pool policy (caps + guaranteed minimums).
-- JSON-as-text; null = unset = uniform/no policy, byte-identical to a
-- preset's behavior before these columns existed. Parsed/validated via
-- src/deck-pool-config-core.ts, never trusted verbatim. Edited at
-- /admin/deck-bans.
ALTER TABLE "MatchConfigPreset" ADD COLUMN "deckWeights" TEXT;
ALTER TABLE "MatchConfigPreset" ADD COLUMN "poolPolicy" TEXT;
