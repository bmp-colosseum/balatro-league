-- Replace the silent auto-enroll flag with an opt-OUT reminder preference.
ALTER TABLE "Player" DROP COLUMN "autoSignup";
ALTER TABLE "Player" ADD COLUMN "signupReminderOptOut" BOOLEAN NOT NULL DEFAULT false;

-- Per-round interactive "are you in?" ask + reminder state.
CREATE TYPE "SignupAskStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'SNOOZED');

CREATE TABLE "SignupAsk" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "status" "SignupAskStatus" NOT NULL DEFAULT 'PENDING',
    "dmChannelId" TEXT,
    "dmMessageId" TEXT,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),
    "snoozedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupAsk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupAsk_roundId_discordId_key" ON "SignupAsk"("roundId", "discordId");
CREATE INDEX "SignupAsk_roundId_status_idx" ON "SignupAsk"("roundId", "status");

ALTER TABLE "SignupAsk" ADD CONSTRAINT "SignupAsk_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SignupRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
