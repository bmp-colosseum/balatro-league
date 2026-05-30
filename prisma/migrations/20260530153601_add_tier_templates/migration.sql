-- CreateTable
CREATE TABLE "TierTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "isLastUsed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TierTemplate_name_key" ON "TierTemplate"("name");
