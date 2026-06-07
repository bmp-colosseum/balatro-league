-- CreateTable
CREATE TABLE "TraitOverride" (
    "key" TEXT NOT NULL,
    "label" TEXT,
    "emoji" TEXT,
    "description" TEXT,
    "iconDataUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "TraitOverride_pkey" PRIMARY KEY ("key")
);

