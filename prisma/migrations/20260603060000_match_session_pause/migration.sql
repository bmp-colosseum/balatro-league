-- Pause-a-match feature: new PAUSED state on MatchSessionState +
-- supporting fields on MatchSession. Mutual-consent flow — pause and
-- resume each require both players to click. match-sweep auto-cancels
-- paused sessions older than 7 days so abandoned pauses don't leak.

ALTER TYPE "MatchSessionState" ADD VALUE IF NOT EXISTS 'PAUSED';

ALTER TABLE "MatchSession" ADD COLUMN "pausedFromState" "MatchSessionState";
ALTER TABLE "MatchSession" ADD COLUMN "pauseInitiatorPlayerId" TEXT;
ALTER TABLE "MatchSession" ADD COLUMN "resumeInitiatorPlayerId" TEXT;
ALTER TABLE "MatchSession" ADD COLUMN "pausedAt" TIMESTAMP(3);
