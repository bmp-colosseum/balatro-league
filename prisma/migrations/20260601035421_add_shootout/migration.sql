-- CreateTable
CREATE TABLE "Shootout" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "playerAId" TEXT NOT NULL,
    "playerBId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "Shootout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shootout_divisionId_idx" ON "Shootout"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Shootout_divisionId_playerAId_playerBId_key" ON "Shootout"("divisionId", "playerAId", "playerBId");

-- AddForeignKey
ALTER TABLE "Shootout" ADD CONSTRAINT "Shootout_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
