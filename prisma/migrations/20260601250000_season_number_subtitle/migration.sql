-- Season identification refactor: drop the free-form `name` column,
-- introduce a required unique `number` (sequential per season) and an
-- optional `subtitle`. Display label is "Season N" or "Season N — Subtitle".
--
-- Backfill strategy: existing seasons get numbers 1..N ordered by
-- startedAt ASC (oldest first). Existing `name` values are discarded —
-- per the pre-launch no-backcompat policy, admin can re-add a subtitle
-- by hand if they want one.

ALTER TABLE "Season" ADD COLUMN "number" INTEGER;
ALTER TABLE "Season" ADD COLUMN "subtitle" TEXT;

-- Backfill numbers chronologically.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "startedAt" ASC) AS rn
  FROM "Season"
)
UPDATE "Season" s
SET "number" = numbered.rn::int
FROM numbered
WHERE s.id = numbered.id;

-- Now that every row has a value, lock it down.
ALTER TABLE "Season" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Season_number_key" ON "Season"("number");

-- Drop the now-unused free-form name.
ALTER TABLE "Season" DROP COLUMN "name";
