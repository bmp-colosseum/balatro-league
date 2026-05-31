-- CreateTable
CREATE TABLE "LeagueConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "LeagueConfig_pkey" PRIMARY KEY ("key")
);
