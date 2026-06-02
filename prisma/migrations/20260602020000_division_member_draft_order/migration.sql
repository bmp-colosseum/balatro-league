-- Per-division ordering for draft mode (admin drags rows between/within
-- divisions on /admin/seasons/[id]). Inert once a season activates —
-- standings don't depend on it — but persisted so re-opening the draft
-- view keeps the last-known order.

ALTER TABLE "DivisionMember" ADD COLUMN "draftOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows with a deterministic per-division order based
-- on joinedAt so the editor shows them in a stable sequence on first
-- render. New rows after this migration get 0 from the DEFAULT and are
-- rebalanced by placePlayerInDivision / moveDivisionMemberToPosition.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "divisionId" ORDER BY "joinedAt" ASC) AS rn
  FROM "DivisionMember"
)
UPDATE "DivisionMember" m
SET "draftOrder" = ordered.rn::int
FROM ordered
WHERE m.id = ordered.id;
