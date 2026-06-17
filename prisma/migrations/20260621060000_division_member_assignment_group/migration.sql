-- Admin-only sub-group index within a division. The division stays the
-- competitive unit (standings + promotion run across all members); the
-- sub-group only scopes who you play (your round-robin opponents). Null =
-- not sub-grouped (legacy everyone-plays-everyone).
ALTER TABLE "DivisionMember" ADD COLUMN "assignmentGroup" INTEGER;
