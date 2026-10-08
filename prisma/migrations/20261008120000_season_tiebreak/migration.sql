-- How a season's standings break a tie that points + head-to-head + shootout
-- can't resolve: "chain" (today's behaviour, unchanged) or "lives" (break by
-- net life differential -- see computeNetLives in web/lib/standings.ts /
-- src/standings.ts). Existing seasons default to "chain" -- no behaviour
-- change until an admin switches a season from /admin/standings-preview.
-- Additive + safe.
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "tiebreak" TEXT NOT NULL DEFAULT 'chain';
