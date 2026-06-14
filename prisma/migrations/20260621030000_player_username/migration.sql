-- The player's Discord @username (handle), e.g. "coolguy". Distinct from
-- displayName (global/nick name) and discordId (numeric). Synced from Discord;
-- shown publicly. Nullable: null until first synced.
ALTER TABLE "Player" ADD COLUMN "username" TEXT;
