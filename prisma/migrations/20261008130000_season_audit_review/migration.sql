-- A TO's dismissal of one /admin/season-audit finding that can never be
-- fixed, keyed by (seasonId, code, key) where key is the finding's own
-- deterministic identity from web/lib/season-audit-core.ts. Additive +
-- safe; idempotent so it can be re-applied by hand before a deploy.
CREATE TABLE IF NOT EXISTS "SeasonAuditReview" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "divisionId" TEXT,
    "code" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "note" TEXT,
    "reviewedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonAuditReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SeasonAuditReview_seasonId_code_key_key" ON "SeasonAuditReview"("seasonId", "code", "key");

CREATE INDEX IF NOT EXISTS "SeasonAuditReview_seasonId_idx" ON "SeasonAuditReview"("seasonId");
