-- Optional deck/stake captured on a manual report (the combo that was played).
ALTER TABLE "Pairing" ADD COLUMN "reportedDeck" TEXT;
ALTER TABLE "Pairing" ADD COLUMN "reportedStake" TEXT;
