/*
  Warnings:

  - Added the required column `discordId` to the `PlayerMmrSnapshot` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "PlayerMmrSnapshot" DROP CONSTRAINT "PlayerMmrSnapshot_playerId_fkey";

-- AlterTable
ALTER TABLE "PlayerMmrSnapshot" ADD COLUMN     "discordId" TEXT NOT NULL,
ALTER COLUMN "playerId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "PlayerMmrSnapshot_discordId_capturedAt_idx" ON "PlayerMmrSnapshot"("discordId", "capturedAt");

-- AddForeignKey
ALTER TABLE "PlayerMmrSnapshot" ADD CONSTRAINT "PlayerMmrSnapshot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
