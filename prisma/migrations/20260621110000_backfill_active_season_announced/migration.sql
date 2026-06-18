-- Safety backfill: pre-claim the start announcement for any season already
-- ACTIVE when this deploys. The "Season N is live" announcement (which pings
-- the new League Player role) is gated on startAnnouncedAt being null, so a
-- season running before this feature existed would otherwise be eligible to
-- announce if it were ever re-bootstrapped. Stamping startAnnouncedAt here
-- means a re-bootstrap of a live season can NEVER fire a surprise ping.
--
-- Newly-activated seasons keep startAnnouncedAt NULL and announce exactly once
-- on activation, as designed.
UPDATE "Season"
SET "startAnnouncedAt" = COALESCE("startedAt", now())
WHERE "isActive" = true AND "startAnnouncedAt" IS NULL;
