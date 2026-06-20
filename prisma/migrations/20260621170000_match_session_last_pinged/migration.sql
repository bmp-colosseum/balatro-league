-- Track who we last @-pinged as the active decision-maker so the control-bump only
-- re-pings on a turn switch, not on a plain move-to-bottom. Additive + safe.
ALTER TABLE "MatchSession" ADD COLUMN "lastPingedDiscordId" TEXT;
