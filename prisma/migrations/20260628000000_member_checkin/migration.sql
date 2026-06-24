-- Activity check-in status per division member ("still playing?" DM tracking).
ALTER TABLE "DivisionMember" ADD COLUMN "checkinStatus" TEXT;
ALTER TABLE "DivisionMember" ADD COLUMN "checkinAt" TIMESTAMP(3);
