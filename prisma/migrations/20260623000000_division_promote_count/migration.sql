-- Per-division promote count, independent of relegateCount: how many of a division's
-- top finishers move up a division at season end. relegateCount already exists (bottom
-- finishers moving down). They no longer have to match — at each boundary both groups
-- cross it, and the next-season rebuild re-sizes divisions. Default 1.
ALTER TABLE "Division" ADD COLUMN "promoteCount" INTEGER NOT NULL DEFAULT 1;
