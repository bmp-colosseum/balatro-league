-- Add seasonId denormalized onto DivisionMember so we can enforce
-- one-division-per-season-per-player at the DB layer.

-- 1) Add column nullable so the backfill can run
ALTER TABLE "DivisionMember" ADD COLUMN "seasonId" TEXT;

-- 2) Backfill from each member's division
UPDATE "DivisionMember" dm
SET "seasonId" = d."seasonId"
FROM "Division" d
WHERE dm."divisionId" = d."id"
  AND dm."seasonId" IS NULL;

-- 3) Dedup before the unique constraint goes on: a player ended up in
--    multiple divisions of the same season. Keep the most recently joined
--    row; for the older ones, also delete any Pairings referencing them
--    in those divisions (would otherwise dangle).
WITH dupes AS (
  SELECT id, "divisionId", "playerId" FROM (
    SELECT id, "divisionId", "playerId",
           ROW_NUMBER() OVER (
             PARTITION BY "seasonId", "playerId"
             ORDER BY "joinedAt" DESC, id DESC
           ) AS rn
    FROM "DivisionMember"
  ) sub
  WHERE rn > 1
)
DELETE FROM "Pairing" p
USING dupes d
WHERE p."divisionId" = d."divisionId"
  AND (p."playerAId" = d."playerId" OR p."playerBId" = d."playerId");

DELETE FROM "DivisionMember"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "seasonId", "playerId"
             ORDER BY "joinedAt" DESC, id DESC
           ) AS rn
    FROM "DivisionMember"
  ) sub
  WHERE rn > 1
);

-- 4) Now safe to make NOT NULL + add the unique constraint
ALTER TABLE "DivisionMember" ALTER COLUMN "seasonId" SET NOT NULL;
CREATE UNIQUE INDEX "DivisionMember_seasonId_playerId_key"
  ON "DivisionMember"("seasonId", "playerId");
