-- AlterTable
ALTER TABLE "MatchSession" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "MatchSession_state_expiresAt_idx" ON "MatchSession"("state", "expiresAt");
