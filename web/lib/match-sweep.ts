// Web-side port of src/match-sweep.ts. Runs the same three passes
// (expired invites, idle sessions, leaked threads) on demand. Used by
// the /admin/config "Run match-thread sweep now" button — admin can
// trigger cleanup if the bot is down or if they want to flush stale
// threads without waiting for the next 1-minute tick.

import { prisma } from "@/lib/prisma";
import { deleteChannel, listArchivedThreadsInChannel, listGuildActiveThreads } from "@/lib/discord";

const IDLE_CANCEL_HOURS = 24;

export interface MatchSweepResult {
  expiredInvitesCancelled: number;
  idleSessionsCancelled: number;
  leakedThreadsProcessed: number;
  leakedThreadsDeleted: number;
  // Manual-pass diagnostics — present only when includeOrphans is true.
  // Make it easy to tell "found 0" from "couldn't even look" when the
  // pass returns 0 orphans.
  orphan?: {
    guildIdConfigured: boolean;
    matchParentChannels: number;
    activeThreadsInGuild: number;
    activeThreadsUnderMatchParents: number;
    archivedThreadsUnderMatchParents: number;
    orphanThreadsFound: number;
    orphanThreadsDeleted: number;
  };
}

// Pass 1: WAITING_ACCEPT sessions past their expiresAt → mark
// CANCELLED + delete thread.
async function sweepExpiredInvites(): Promise<number> {
  const expired = await prisma.matchSession.findMany({
    where: { state: "WAITING_ACCEPT", expiresAt: { lt: new Date() } },
    select: { id: true, threadId: true },
  });
  for (const s of expired) {
    await prisma.matchSession.update({
      where: { id: s.id },
      data: { state: "CANCELLED", version: { increment: 1 } },
    }).catch(() => {});
    if (s.threadId) {
      const ok = await deleteChannel(s.threadId);
      if (ok) {
        await prisma.matchSession.update({
          where: { id: s.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      }
    }
  }
  return expired.length;
}

// Pass 2: any non-terminal session with no activity for 24h → cancel
// + delete thread. Catches mid-game ghosts.
async function sweepIdleSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - IDLE_CANCEL_HOURS * 60 * 60 * 1000);
  const stale = await prisma.matchSession.findMany({
    where: {
      state: { notIn: ["COMPLETE", "CANCELLED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, threadId: true },
    take: 50,
  });
  for (const s of stale) {
    await prisma.matchSession.update({
      where: { id: s.id },
      data: { state: "CANCELLED", version: { increment: 1 } },
    }).catch(() => {});
    if (s.threadId) {
      const ok = await deleteChannel(s.threadId);
      if (ok) {
        await prisma.matchSession.update({
          where: { id: s.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      }
    }
  }
  return stale.length;
}

// Pass 3: terminal-state sessions whose threadArchivedAt is still null
// — inline delete during finish/cancel must have failed. Retry the
// delete and stamp threadArchivedAt regardless of outcome (so we don't
// retry every minute on a permanently broken thread).
async function sweepLeakedThreads(): Promise<{ processed: number; deleted: number }> {
  const leaked = await prisma.matchSession.findMany({
    where: {
      state: { in: ["COMPLETE", "CANCELLED"] },
      threadId: { not: null },
      threadArchivedAt: null,
    },
    select: { id: true, threadId: true },
    orderBy: { updatedAt: "asc" },
    take: 50,
  });
  let deleted = 0;
  for (const s of leaked) {
    if (!s.threadId) continue;
    const ok = await deleteChannel(s.threadId);
    if (ok) deleted++;
    await prisma.matchSession.update({
      where: { id: s.id },
      data: { threadArchivedAt: new Date() },
    }).catch(() => {});
  }
  return { processed: leaked.length, deleted };
}

// Pass 4 (manual-only): scan Discord for threads under known match-
// parent channels (challenges channel + division channels) that have
// NO MatchSession row tracking them. Scans BOTH active and archived
// threads — Discord auto-archives idle threads after their
// autoArchiveDuration, so a "stale" thread the admin sees is usually
// archived, not active. Listing archived is per-parent-channel and
// paginated, which is why this pass is manual-only (too expensive for
// a 1-minute cron, fine for a button press).
async function sweepOrphanThreads(): Promise<NonNullable<MatchSweepResult["orphan"]>> {
  const guildId = process.env.DISCORD_GUILD_ID;
  const base = {
    guildIdConfigured: !!guildId,
    matchParentChannels: 0,
    activeThreadsInGuild: 0,
    activeThreadsUnderMatchParents: 0,
    archivedThreadsUnderMatchParents: 0,
    orphanThreadsFound: 0,
    orphanThreadsDeleted: 0,
  };
  if (!guildId) return base;

  const challengesParent = (
    await prisma.leagueConfig.findUnique({ where: { key: "challenges_channel_id" } })
  )?.value;
  const divisionChannels = await prisma.division.findMany({
    where: { discordChannelId: { not: null } },
    select: { discordChannelId: true },
  });
  const matchParentIds = new Set<string>();
  if (challengesParent) matchParentIds.add(challengesParent);
  for (const d of divisionChannels) {
    if (d.discordChannelId) matchParentIds.add(d.discordChannelId);
  }
  base.matchParentChannels = matchParentIds.size;
  if (matchParentIds.size === 0) return base;

  // Active threads (guild-wide, then filter).
  const activeAll = await listGuildActiveThreads(guildId);
  base.activeThreadsInGuild = activeAll.length;
  const activeUnderParents = activeAll.filter(
    (t) => t.parentId && matchParentIds.has(t.parentId),
  );
  base.activeThreadsUnderMatchParents = activeUnderParents.length;

  // Archived threads (per-parent-channel; Discord doesn't have a guild
  // endpoint for these).
  const archivedUnderParents: Array<{ id: string; name: string; parentId: string }> = [];
  for (const parentId of matchParentIds) {
    const archived = await listArchivedThreadsInChannel(parentId);
    archivedUnderParents.push(...archived);
  }
  base.archivedThreadsUnderMatchParents = archivedUnderParents.length;

  const allUnderParents = [...activeUnderParents, ...archivedUnderParents];
  if (allUnderParents.length === 0) return base;

  const trackedIds = new Set(
    (await prisma.matchSession.findMany({
      where: { threadId: { in: allUnderParents.map((t) => t.id) } },
      select: { threadId: true },
    }))
      .map((s) => s.threadId)
      .filter((id): id is string => !!id),
  );

  const orphans = allUnderParents.filter((t) => !trackedIds.has(t.id));
  base.orphanThreadsFound = orphans.length;
  let deleted = 0;
  for (const t of orphans) {
    const ok = await deleteChannel(t.id);
    if (ok) deleted++;
  }
  base.orphanThreadsDeleted = deleted;
  if (orphans.length > 0) {
    console.log(`[match-sweep orphans] found ${orphans.length}, deleted ${deleted}`);
  }
  return base;
}

export async function runMatchSweep(opts: { includeOrphans?: boolean } = {}): Promise<MatchSweepResult> {
  const expiredInvitesCancelled = await sweepExpiredInvites();
  const idleSessionsCancelled = await sweepIdleSessions();
  const { processed: leakedThreadsProcessed, deleted: leakedThreadsDeleted } =
    await sweepLeakedThreads();
  const result: MatchSweepResult = {
    expiredInvitesCancelled,
    idleSessionsCancelled,
    leakedThreadsProcessed,
    leakedThreadsDeleted,
  };
  if (opts.includeOrphans) {
    result.orphan = await sweepOrphanThreads();
  }
  return result;
}
