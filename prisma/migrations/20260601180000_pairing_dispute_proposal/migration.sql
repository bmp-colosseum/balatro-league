-- Dispute proposal: lets the disputing player suggest what the result
-- SHOULD have been, so admin/helper can one-click accept it from
-- /admin/disputes. All nullable so a no-proposal dispute (Discord button
-- path) still works.
ALTER TABLE "Pairing" ADD COLUMN "disputedById" TEXT;
ALTER TABLE "Pairing" ADD COLUMN "disputeProposedGamesWonA" INTEGER;
ALTER TABLE "Pairing" ADD COLUMN "disputeProposedGamesWonB" INTEGER;
ALTER TABLE "Pairing" ADD COLUMN "disputeReason" TEXT;
ALTER TABLE "Pairing" ADD COLUMN "disputedAt" TIMESTAMP(3);
ALTER TABLE "Pairing" ADD COLUMN "disputeThreadId" TEXT;

ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_disputedById_fkey"
  FOREIGN KEY ("disputedById") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
