-- CreateTable
CREATE TABLE "SignupRound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "resultingSeasonId" TEXT
);

-- CreateTable
CREATE TABLE "Signup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roundId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mpUsername" TEXT,
    "mpMmr" INTEGER,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "signedUpAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signup_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SignupRound" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SignupRound_status_idx" ON "SignupRound"("status");

-- CreateIndex
CREATE INDEX "Signup_roundId_withdrawn_idx" ON "Signup"("roundId", "withdrawn");

-- CreateIndex
CREATE UNIQUE INDEX "Signup_roundId_discordId_key" ON "Signup"("roundId", "discordId");
