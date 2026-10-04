-- CreateTable
CREATE TABLE "DmConversationState" (
    "discordId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "archivedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmConversationState_pkey" PRIMARY KEY ("discordId")
);
