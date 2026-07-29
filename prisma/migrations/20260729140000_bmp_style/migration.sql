-- BMP-style bans: a per-session flag that draws the pool from the fixed
-- BMP_POOL vocabulary instead of the resolved preset. Additive, defaulted,
-- backward-compatible.
ALTER TABLE "MatchSession" ADD COLUMN "bmpStyle" BOOLEAN NOT NULL DEFAULT false;
