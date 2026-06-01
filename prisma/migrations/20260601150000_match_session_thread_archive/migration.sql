-- Track when the archive.stale-threads cron has locked + archived the
-- session's Discord thread. NULL means "still needs a sweep" (or never
-- had a thread). Set on inline close OR by the cron once we know there's
-- nothing more to do.
ALTER TABLE "MatchSession" ADD COLUMN "threadArchivedAt" TIMESTAMP(3);

-- Cron predicate: sweep COMPLETE/CANCELLED sessions whose thread
-- hasn't been archived yet.
CREATE INDEX "MatchSession_state_threadArchivedAt_idx" ON "MatchSession"("state", "threadArchivedAt");
