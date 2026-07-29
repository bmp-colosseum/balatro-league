-- Bo5 "no repeats" support for casual /challenge finals: eight new match-session
-- states (games 4 and 5, each with choose-first/ban/pick/playing), game4/game5
-- JSON storage columns, and a per-session noRepeatCombos flag. Adding enum values
-- is transaction-safe on PostgreSQL 12+ (the new values are not used in this
-- migration). IF NOT EXISTS keeps a re-run idempotent.
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_4_CHOOSE_FIRST';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_4_BAN';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_4_PICK';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_4_PLAYING';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_5_CHOOSE_FIRST';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_5_BAN';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_5_PICK';
ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'GAME_5_PLAYING';

ALTER TABLE "MatchSession" ADD COLUMN "game4" TEXT;
ALTER TABLE "MatchSession" ADD COLUMN "game5" TEXT;
ALTER TABLE "MatchSession" ADD COLUMN "noRepeatCombos" BOOLEAN NOT NULL DEFAULT false;
