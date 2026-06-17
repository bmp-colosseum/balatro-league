-- Per-sub-group "Group N" thread ids for a division, as a JSON map of
-- {"<groupNumber>":"<threadId>"}. Written by the division bootstrap; lets us
-- count real threads + recreate only missing ones. Null when not sub-grouped.
ALTER TABLE "Division" ADD COLUMN "subGroupThreadIds" JSONB;
