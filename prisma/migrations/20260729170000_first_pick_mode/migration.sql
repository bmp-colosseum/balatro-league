-- Configurable "who bans first in games 2+" rule. Plain string, not a Prisma
-- enum, so an unrecognized/legacy value never breaks a live match (see
-- parseFirstPickMode in src/match-session.ts). Per-match on MatchSession,
-- league-wide default on LeagueRulesTemplate (read via LeagueSettings and
-- stamped onto league match sessions at create time).
ALTER TABLE "MatchSession" ADD COLUMN "firstPickMode" TEXT NOT NULL DEFAULT 'LOSER_CHOOSES';
ALTER TABLE "LeagueRulesTemplate" ADD COLUMN "firstPickMode" TEXT NOT NULL DEFAULT 'LOSER_CHOOSES';
