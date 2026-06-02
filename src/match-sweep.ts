// Periodic sweep for stale match sessions. Runs on bot boot (to catch
// expirations that happened during a redeploy) and every minute thereafter.
//
// Three passes:
//   1. WAITING_ACCEPT past expiresAt → cancel (5 min default expiry,
//      handleAccept also checks but the sweep is the safety net when
//      nobody clicks at all).
//   2. Any non-terminal state with updatedAt > 24h ago → cancel as
//      'abandoned'. Catches mid-game sessions where players ghosted —
//      otherwise they'd sit in GAME_1_PLAYING or similar forever and
//      keep their threads alive.
//   3. COMPLETE/CANCELLED sessions where the inline thread delete never
//      stamped threadArchivedAt (bot was offline at the moment, Discord
//      5xx, perms briefly revoked). Tries the delete again. Marks
//      threadArchivedAt regardless of outcome so we don't hammer a
//      broken thread forever.
//
// All three passes delete threads via REST so the sweep works even
// without a connected gateway client.

import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { logDiscordError } from "./log-discord-error.js";

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

    // Delete the abandoned thread immediately — no point keeping an
    // expired-invite shell around. REST works even without a live
    // gateway client. Best-effort — failures leave threadArchivedAt
    // null so the 24h stale-threads cron can retry.
    if (session.threadId) {
      try {
        await rest().delete(Routes.channel(session.threadId));
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        logDiscordError("match-sweep.expiredInvite.deleteThread", err, {
          threadId: session.threadId,
          sessionId: session.id,
        });
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
        await rest().delete(Routes.channel(session.threadId));
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        logDiscordError("match-sweep.idle.deleteThread", err, {
          threadId: session.threadId,
          sessionId: session.id,
        });
      }
    }
  }
  console.log(`[match-sweep idle] cancelled ${stale.length} abandoned session(s) (>${IDLE_CANCEL_HOURS}h stale)`);
  return stale.length;
}

// Safety-net pass: COMPLETE or CANCELLED sessions whose threadId is
// still set but threadArchivedAt is null mean the inline delete never
// stamped success. Try again. Mark threadArchivedAt regardless of
// outcome (success → great; failure → don't keep retrying forever).
//
// Capped at 50/tick so a backlog from a long bot outage doesn't burst
// hundreds of Discord deletes in one minute. The next tick picks up
// the next 50.
const COMPLETED_SWEEP_BATCH = 50;

export async function sweepLeakedThreads(): Promise<number> {
  const leaked = await prisma.matchSession.findMany({
    where: {
      state: { in: ["COMPLETE", "CANCELLED"] },
      threadId: { not: null },
      threadArchivedAt: null,
    },
    select: { id: true, threadId: true },
    orderBy: { updatedAt: "asc" },
    take: COMPLETED_SWEEP_BATCH,
  });
  if (leaked.length === 0) return 0;

  let deleted = 0;
  for (const session of leaked) {
    if (!session.threadId) continue;
    try {
      await rest().delete(Routes.channel(session.threadId));
      deleted++;
    } catch (err) {
      logDiscordError("match-sweep.leaked.deleteThread", err, {
        threadId: session.threadId,
        sessionId: session.id,
      });
    }
    // Stamp regardless — if the delete failed (thread already gone,
    // perms revoked), retrying every minute just wastes API budget.
    await prisma.matchSession.update({
      where: { id: session.id },
      data: { threadArchivedAt: new Date() },
    }).catch(() => {});
  }
  if (deleted > 0 || leaked.length > 0) {
    console.log(`[match-sweep leaked] processed ${leaked.length} thread(s), deleted ${deleted}`);
  }
  return leaked.length;
}

export function startMatchSweep(): void {
  // Run all passes once immediately on boot.
  sweepExpiredInvites().catch((err) => console.warn("[match-sweep] boot expiry sweep failed:", err));
  sweepIdleSessions().catch((err) => console.warn("[match-sweep] boot idle sweep failed:", err));
  sweepLeakedThreads().catch((err) => console.warn("[match-sweep] boot leaked sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] expiry tick failed:", err));
    sweepIdleSessions().catch((err) => console.warn("[match-sweep] idle tick failed:", err));
    sweepLeakedThreads().catch((err) => console.warn("[match-sweep] leaked tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}
