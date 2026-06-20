-- Per-division schedule format override: true = round-robin, false = 4-opponent
-- graph, NULL = use the season's roundRobinTopDivisions default. Additive + safe
-- (existing divisions are NULL → unchanged behavior).
ALTER TABLE "Division" ADD COLUMN "roundRobin" BOOLEAN;
