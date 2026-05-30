-- AlterTable
ALTER TABLE "Player" ADD COLUMN "rating" INTEGER;
ALTER TABLE "Player" ADD COLUMN "ratingNote" TEXT;

-- CreateIndex
CREATE INDEX "Player_rating_idx" ON "Player"("rating");
