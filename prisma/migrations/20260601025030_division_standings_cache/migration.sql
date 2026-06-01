-- CreateTable
CREATE TABLE "DivisionStandings" (
    "divisionId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowsJson" TEXT NOT NULL,

    CONSTRAINT "DivisionStandings_pkey" PRIMARY KEY ("divisionId")
);

-- AddForeignKey
ALTER TABLE "DivisionStandings" ADD CONSTRAINT "DivisionStandings_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
