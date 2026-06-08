-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "autoSignup" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Strike" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Strike_playerId_idx" ON "Strike"("playerId");

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

