-- CreateTable
CREATE TABLE "SeasonInterest" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeasonInterest_discordId_key" ON "SeasonInterest"("discordId");
