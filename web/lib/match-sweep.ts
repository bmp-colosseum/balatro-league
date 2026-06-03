// Web-side port of src/match-sweep.ts. Runs the same three passes
// (expired invites, idle sessions, leaked threads) on demand. Used by
// the /admin/config "Run match-thread sweep now" button — admin can
// trigger cleanup if the bot is down or if they want to flush stale
// threads without waiting for the next 1-minute tick.

import { prisma } from "@/lib/prisma";
import { deleteChannel } from "@/lib/discord";

const IDLE_CANCEL_HOURS = 24;

export interface MatchSweepResult {
  expiredInvitesCancelled: number;
  idleSessionsCancelled: number;
  leakedThreadsProcessed: number;
  leakedThreadsDeleted: number;
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

export async function runMatchSweep(): Promise<MatchSweepResult> {
  const expiredInvitesCancelled = await sweepExpiredInvites();
  const idleSessionsCancelled = await sweepIdleSessions();
  const { processed: leakedThreadsProcessed, deleted: leakedThreadsDeleted } =
    await sweepLeakedThreads();
  return {
    expiredInvitesCancelled,
    idleSessionsCancelled,
    leakedThreadsProcessed,
    leakedThreadsDeleted,
  };
}
