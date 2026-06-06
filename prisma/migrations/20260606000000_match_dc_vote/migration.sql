-- Mutual-consent opponent-DC claim: the claimant reports a disconnect,
-- the opponent confirms (forfeit) or disputes.
ALTER TABLE "MatchSession" ADD COLUMN "dcInitiatorPlayerId" TEXT;
