-- CreateTable
CREATE TABLE "DmAttachment" (
    "id" TEXT NOT NULL,
    "inboundDmId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "discordUrl" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DmAttachment_inboundDmId_idx" ON "DmAttachment"("inboundDmId");
