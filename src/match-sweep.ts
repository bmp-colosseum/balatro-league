// Periodic sweep for stale match sessions. Runs on bot boot (to catch
// expirations that happened during a redeploy) and every minute thereafter.
//
// Two passes:
//   1. WAITING_ACCEPT past expiresAt → cancel (5 min default expiry,
//      handleAccept also checks but the sweep is the safety net when
//      nobody clicks at all).
//   2. Any non-terminal state with updatedAt > 24h ago → cancel as
//      'abandoned'. Catches mid-game sessions where players ghosted —
//      otherwise they'd sit in GAME_1_PLAYING or similar forever and
//      keep their threads alive.
//
// Both paths lock + archive the Discord thread immediately on cancel.

import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { prisma } from "./db.js";
import { env } from "./env.js";

const SWEEP_INTERVAL_MS = 60 * 1000;
const IDLE_CANCEL_HOURS = 24;

let cachedRest: REST | null = null;
function rest(): REST {
  if (!cachedRest) cachedRest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  return cachedRest;
}

export async function sweepExpiredInvites(): Promise<number> {
  // Select the sessions first so we can hit their threads. Then mark
  // them CANCELLED in bulk. updateMany would have been faster but it
  // doesn't return the rows, and we need threadIds.
  const expired = await prisma.matchSession.findMany({
    where: {
      state: "WAITING_ACCEPT",
      expiresAt: { lt: new Date() },
    },
    select: { id: true, threadId: true, version: true },
  });
  if (expired.length === 0) return 0;

  for (const session of expired) {
    await prisma.matchSession.update({
      where: { id: session.id },
      data: {
        state: "CANCELLED",
        version: { increment: 1 },
      },
    }).catch((err) => {
      console.warn(`[match-sweep] cancel ${session.id} failed:`, err);
    });

    // Close the thread immediately so the abandoned invite doesn't
    // sit open. setLocked + setArchived via REST works even without
    // a live gateway client. Best-effort — failures (thread deleted,
    // permissions revoked) leave threadArchivedAt null so the 24h
    // stale-threads cron can retry.
    if (session.threadId) {
      try {
        await rest().patch(Routes.channel(session.threadId), {
          body: { locked: true, archived: true },
        });
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        console.warn(`[match-sweep] thread close ${session.threadId} failed:`, err);
      }
    }
  }
  console.log(`[match-sweep] cancelled ${expired.length} expired invite(s)`);
  return expired.length;
}

// Cancel sessions stuck in a non-terminal state with no activity for
// 24h+ — players ghosted mid-game, accept never came after the 5min
// invite expiry edge case slipped through, etc. Same thread-close
// pattern as sweepExpiredInvites.
export async function sweepIdleSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - IDLE_CANCEL_HOURS * 60 * 60 * 1000);
  const stale = await prisma.matchSession.findMany({
    where: {
      state: { notIn: ["COMPLETE", "CANCELLED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, threadId: true, state: true, updatedAt: true },
    take: 50,
  });
  if (stale.length === 0) return 0;

  for (const session of stale) {
    await prisma.matchSession.update({
      where: { id: session.id },
      data: {
        state: "CANCELLED",
        version: { increment: 1 },
      },
    }).catch((err) => {
      console.warn(`[match-sweep idle] cancel ${session.id} failed:`, err);
    });
    if (session.threadId) {
      try {
        await rest().patch(Routes.channel(session.threadId), {
          body: { locked: true, archived: true },
        });
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        console.warn(`[match-sweep idle] thread close ${session.threadId} failed:`, err);
      }
    }
  }
  console.log(`[match-sweep idle] cancelled ${stale.length} abandoned session(s) (>${IDLE_CANCEL_HOURS}h stale)`);
  return stale.length;
}

export function startMatchSweep(): void {
  // Run both passes once immediately on boot.
  sweepExpiredInvites().catch((err) => console.warn("[match-sweep] boot expiry sweep failed:", err));
  sweepIdleSessions().catch((err) => console.warn("[match-sweep] boot idle sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] expiry tick failed:", err));
    sweepIdleSessions().catch((err) => console.warn("[match-sweep] idle tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}
