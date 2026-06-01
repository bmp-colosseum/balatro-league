-- Snapshot of the league match policy (firstPlayerBans, secondPlayerBans,
-- poolSize) on each session at creation time. NULL = use current
-- LeagueSettings defaults — covers in-flight sessions that predate the
-- column.
ALTER TABLE "MatchSession" ADD COLUMN "policy" TEXT;
