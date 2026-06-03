// Periodic sweep for stale match sessions. Runs on bot boot (to catch
// expirations that happened during a redeploy) and every minute thereafter.
//
// Five passes:
//   1. WAITING_ACCEPT past expiresAt → cancel (5 min default expiry,
//      handleAccept also checks but the sweep is the safety net when
//      nobody clicks at all).
//   2. Any non-terminal state (excluding PAUSED) with updatedAt > 24h
//      ago → cancel as 'abandoned'. Catches mid-game sessions where
//      players ghosted. PAUSED gets its own longer grace via pass 3.
//   3. PAUSED sessions with pausedAt > 7d ago → cancel. Players who
//      pause are explicitly opting in to "we'll come back" — the long
//      grace lets life happen without the idle sweep killing the match.
//   4. COMPLETE/CANCELLED sessions where the inline thread delete never
//      stamped threadArchivedAt (bot was offline at the moment, Discord
//      5xx, perms briefly revoked). Tries the delete again. Marks
//      threadArchivedAt regardless of outcome so we don't hammer a
//      broken thread forever.
//   5. Seasons with scheduledStartAt <= now() and not yet active →
//      auto-activate. Mirrors the web's performSeasonActivation flow:
//      deactivate any prior active season, flip target to isActive,
//      clear scheduledStartAt, post to announcements channel.
//
// All three passes delete threads via REST so the sweep works even
// without a connected gateway client.

import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { resolveAnnouncementsChannelId } from "./announcements-channel.js";
import { prisma } from "./db.js";
import { ensureGuildCategory } from "./discord-helpers.js";
import { env } from "./env.js";
import { formatSeasonLabel } from "./format-season.js";
import { logDiscordError } from "./log-discord-error.js";
import { enqueueBootstrapDivision, enqueueLeagueInfoRefresh } from "./queue.js";
import { recordAudit, SYSTEM_ACTOR } from "./audit.js";

const SWEEP_INTERVAL_MS = 60 * 1000;
const IDLE_CANCEL_HOURS = 24;
const PAUSED_CANCEL_DAYS = 7;

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
      // PAUSED gets its own (longer) grace window in sweepPausedSessions —
      // skip it here so a 24h pause doesn't get auto-cancelled.
      state: { notIn: ["COMPLETE", "CANCELLED", "PAUSED"] },
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

// Long-grace pass for PAUSED sessions: if nobody resumed within 7
// days, cancel the match outright so abandoned pauses don't sit in the
// DB indefinitely. Mirrors the thread-delete pattern from idle/expiry.
export async function sweepPausedSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - PAUSED_CANCEL_DAYS * 24 * 60 * 60 * 1000);
  const stale = await prisma.matchSession.findMany({
    where: {
      state: "PAUSED",
      pausedAt: { lt: cutoff },
    },
    select: { id: true, threadId: true, pausedAt: true },
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
      console.warn(`[match-sweep paused] cancel ${session.id} failed:`, err);
    });
    if (session.threadId) {
      try {
        await rest().delete(Routes.channel(session.threadId));
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { threadArchivedAt: new Date() },
        }).catch(() => {});
      } catch (err) {
        logDiscordError("match-sweep.paused.deleteThread", err, {
          threadId: session.threadId,
          sessionId: session.id,
        });
      }
    }
  }
  console.log(`[match-sweep paused] cancelled ${stale.length} paused session(s) (>${PAUSED_CANCEL_DAYS}d paused)`);
  return stale.length;
}

// Auto-activate seasons whose scheduledStartAt has passed. Mirrors
// web's performSeasonActivation closely so manual vs auto produces
// the same DB state.
export async function sweepScheduledStarts(): Promise<number> {
  const due = await prisma.season.findMany({
    where: {
      isActive: false,
      endedAt: null,
      scheduledStartAt: { lte: new Date(), not: null },
    },
    select: { id: true, number: true, subtitle: true, scheduledStartAt: true },
    orderBy: { scheduledStartAt: "asc" },
    take: 5, // tiny cap — concurrent multi-season activations would be a real surprise
  });
  if (due.length === 0) return 0;

  for (const season of due) {
    const label = formatSeasonLabel({ number: season.number, subtitle: season.subtitle });
    try {
      // Deactivate any prior active season first.
      const prior = await prisma.season.findFirst({
        where: { isActive: true, NOT: { id: season.id } },
        select: { id: true, number: true, subtitle: true },
      });
      if (prior) {
        await prisma.season.update({
          where: { id: prior.id },
          data: { isActive: false, endedAt: new Date() },
        });
      }
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive: true, endedAt: null, scheduledStartAt: null },
      });
      recordAudit({
        actor: SYSTEM_ACTOR,
        action: "season.activate-scheduled",
        targetType: "Season",
        targetId: season.id,
        summary: `Auto-activated "${label}" via scheduledStartAt${prior ? ` (deactivated "${formatSeasonLabel(prior)}")` : ""}`,
        metadata: {
          source: "scheduled",
          scheduledStartAt: season.scheduledStartAt?.toISOString() ?? null,
          previousActiveSeasonId: prior?.id ?? null,
        },
      });
      // Auto-bootstrap Discord (per-division roles + channels). Mirrors
      // web's runSeasonDiscordBootstrap — ensure the season category
      // exists, then enqueue one bootstrap.division job per division
      // that isn't already fully set up. Empty divisions are skipped.
      // Best-effort: failures here don't block the activation itself.
      if (env.DISCORD_GUILD_ID) {
        try {
          const full = await prisma.season.findUnique({
            where: { id: season.id },
            include: {
              divisions: {
                orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
                select: {
                  id: true,
                  discordRoleId: true,
                  discordChannelId: true,
                  _count: { select: { members: { where: { status: "ACTIVE" } } } },
                },
              },
            },
          });
          if (full) {
            if (!full.discordCategoryId) {
              const cat = await ensureGuildCategory(env.DISCORD_GUILD_ID, `🃏 ${label}`);
              if (cat) {
                await prisma.season.update({
                  where: { id: full.id },
                  data: { discordCategoryId: cat.id },
                });
              }
            }
            let queued = 0;
            for (const div of full.divisions) {
              if (div.discordRoleId && div.discordChannelId) continue;
              if (div._count.members === 0) continue;
              await enqueueBootstrapDivision({ divisionId: div.id, guildId: env.DISCORD_GUILD_ID });
              queued++;
            }
            if (queued > 0) {
              console.log(`[match-sweep scheduled-start] queued ${queued} division bootstrap jobs for ${label}`);
            }
          }
        } catch (err) {
          console.warn(`[match-sweep scheduled-start] Discord bootstrap failed for ${season.id}:`, err);
        }
      }
      // Best-effort announcement post.
      const channelId = await resolveAnnouncementsChannelId().catch(() => null);
      if (channelId) {
        const content = `🃏 **${label}** is now live! Standings, /start-match, and /report are all active. Good luck.`;
        try {
          await rest().post(Routes.channelMessages(channelId), { body: { content } });
        } catch (err) {
          logDiscordError("match-sweep.scheduled-start.announce", err, {
            channelId,
            sessionId: season.id, // re-using sessionId field for season id; same ID-correlation purpose
          });
        }
      }
      // Refresh #league-info so the dynamic block reflects the new
      // active season. Best-effort — failure doesn't block activation.
      await enqueueLeagueInfoRefresh().catch((err) =>
        console.warn("[match-sweep scheduled-start] league-info refresh enqueue failed:", err),
      );
      console.log(`[match-sweep scheduled-start] activated season ${season.id} (${label})`);
    } catch (err) {
      console.warn(`[match-sweep scheduled-start] failed for ${season.id}:`, err);
    }
  }
  return due.length;
}

export function startMatchSweep(): void {
  // Run all passes once immediately on boot.
  sweepExpiredInvites().catch((err) => console.warn("[match-sweep] boot expiry sweep failed:", err));
  sweepIdleSessions().catch((err) => console.warn("[match-sweep] boot idle sweep failed:", err));
  sweepPausedSessions().catch((err) => console.warn("[match-sweep] boot paused sweep failed:", err));
  sweepLeakedThreads().catch((err) => console.warn("[match-sweep] boot leaked sweep failed:", err));
  sweepScheduledStarts().catch((err) => console.warn("[match-sweep] boot scheduled-start sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] expiry tick failed:", err));
    sweepIdleSessions().catch((err) => console.warn("[match-sweep] idle tick failed:", err));
    sweepPausedSessions().catch((err) => console.warn("[match-sweep] paused tick failed:", err));
    sweepLeakedThreads().catch((err) => console.warn("[match-sweep] leaked tick failed:", err));
    sweepScheduledStarts().catch((err) => console.warn("[match-sweep] scheduled-start tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}
