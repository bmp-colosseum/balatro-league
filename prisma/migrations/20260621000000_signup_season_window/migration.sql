-- Planned season window shown in the signup post (display-only). Both
-- nullable: when unset the window line is simply omitted from the embed.
ALTER TABLE "SignupRound" ADD COLUMN "seasonStartsAt" TIMESTAMP(3);
ALTER TABLE "SignupRound" ADD COLUMN "seasonEndsAt" TIMESTAMP(3);
