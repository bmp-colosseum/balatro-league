-- Idempotent: safe to re-run / apply by hand against prod.
ALTER TABLE "GuildMember" ADD COLUMN IF NOT EXISTS "avatar" TEXT;
