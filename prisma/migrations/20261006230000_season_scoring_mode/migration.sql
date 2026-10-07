-- Which standings engine a season's LIVE standings use: "all" (every
-- confirmed result counts, today's behaviour), "best-n-count", or
-- "best-n-void" (see web/lib/standings-mode.ts for the selector). Existing
-- seasons default to "all" -- no behaviour change until an admin switches
-- a season from /admin/standings-preview. Additive + safe.
ALTER TABLE "Season" ADD COLUMN "scoringMode" TEXT NOT NULL DEFAULT 'all';
