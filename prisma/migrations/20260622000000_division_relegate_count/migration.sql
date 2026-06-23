-- Per-division relegate count: how many of a division's bottom finishers relegate
-- down to the division below at season end. Mirrored as the promotion count up from
-- the division below (a balanced swap). Drives both the /standings zones and the
-- end-season rating chain swap, replacing the per-tier promoteRelegateCount for the
-- actual movement. Default 1 matches the prior hardcoded 1-up/1-down behavior.
ALTER TABLE "Division" ADD COLUMN "relegateCount" INTEGER NOT NULL DEFAULT 1;
