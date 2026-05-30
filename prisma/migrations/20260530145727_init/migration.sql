-- CreateEnum
CREATE TYPE "SeasonVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SignupStatus" AS ENUM ('OPEN', 'CLOSED', 'BUILT');

-- CreateEnum
CREATE TYPE "PermissionTier" AS ENUM ('OWNER', 'ADMIN', 'MOD');

-- CreateEnum
CREATE TYPE "DivisionMemberStatus" AS ENUM ('ACTIVE', 'DROPPED');

-- CreateEnum
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISPUTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rating" INTEGER,
    "ratingNote" TEXT,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "visibility" "SeasonVisibility" NOT NULL DEFAULT 'PUBLIC',
    "targetGroupSize" INTEGER NOT NULL DEFAULT 5,
    "minGroupSize" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignupRound" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "SignupStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "resultingSeasonId" TEXT,

    CONSTRAINT "SignupRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signup" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mpUsername" TEXT,
    "mpMmr" INTEGER,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleBinding" (
    "id" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "tier" "PermissionTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "RoleBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tier" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "groupNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "discordRoleId" TEXT,
    "discordChannelId" TEXT,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DivisionMember" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DivisionMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "droppedAt" TIMESTAMP(3),
    "dropoutReason" TEXT,

    CONSTRAINT "DivisionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pairing" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "playerAId" TEXT NOT NULL,
    "playerBId" TEXT NOT NULL,
    "gamesWonA" INTEGER NOT NULL DEFAULT 0,
    "gamesWonB" INTEGER NOT NULL DEFAULT 0,
    "status" "PairingStatus" NOT NULL DEFAULT 'PENDING',
    "reporterId" TEXT,
    "reportedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "adminOverrideBy" TEXT,
    "adminOverrideReason" TEXT,

    CONSTRAINT "Pairing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_discordId_key" ON "Player"("discordId");

-- CreateIndex
CREATE INDEX "Player_rating_idx" ON "Player"("rating");

-- CreateIndex
CREATE INDEX "Season_isActive_visibility_idx" ON "Season"("isActive", "visibility");

-- CreateIndex
CREATE INDEX "SignupRound_status_idx" ON "SignupRound"("status");

-- CreateIndex
CREATE INDEX "Signup_roundId_withdrawn_idx" ON "Signup"("roundId", "withdrawn");

-- CreateIndex
CREATE UNIQUE INDEX "Signup_roundId_discordId_key" ON "Signup"("roundId", "discordId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleBinding_discordRoleId_key" ON "RoleBinding"("discordRoleId");

-- CreateIndex
CREATE INDEX "RoleBinding_tier_idx" ON "RoleBinding"("tier");

-- CreateIndex
CREATE INDEX "Tier_seasonId_idx" ON "Tier"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "Tier_seasonId_position_key" ON "Tier"("seasonId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Tier_seasonId_name_key" ON "Tier"("seasonId", "name");

-- CreateIndex
CREATE INDEX "Division_seasonId_idx" ON "Division"("seasonId");

-- CreateIndex
CREATE INDEX "Division_tierId_idx" ON "Division"("tierId");

-- CreateIndex
CREATE UNIQUE INDEX "Division_seasonId_tierId_groupNumber_key" ON "Division"("seasonId", "tierId", "groupNumber");

-- CreateIndex
CREATE INDEX "DivisionMember_playerId_idx" ON "DivisionMember"("playerId");

-- CreateIndex
CREATE INDEX "DivisionMember_divisionId_status_idx" ON "DivisionMember"("divisionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DivisionMember_divisionId_playerId_key" ON "DivisionMember"("divisionId", "playerId");

-- CreateIndex
CREATE INDEX "Pairing_divisionId_status_idx" ON "Pairing"("divisionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Pairing_divisionId_playerAId_playerBId_key" ON "Pairing"("divisionId", "playerAId", "playerBId");

-- AddForeignKey
ALTER TABLE "Signup" ADD CONSTRAINT "Signup_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SignupRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier" ADD CONSTRAINT "Tier_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionMember" ADD CONSTRAINT "DivisionMember_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionMember" ADD CONSTRAINT "DivisionMember_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_playerAId_fkey" FOREIGN KEY ("playerAId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_playerBId_fkey" FOREIGN KEY ("playerBId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
