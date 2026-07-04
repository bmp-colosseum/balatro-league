// Periodic sweep for stale match sessions. Runs on bot boot (to catch
// expirations that happened during a redeploy) and every minute thereafter.
//
// Six passes:
//   1. WAITING_ACCEPT past expiresAt → cancel (5 min default expiry,
//      handleAccept also checks but the sweep is the safety net when
//      nobody clicks at all).
//   1b. An UNDERWAY match (a game has started) idle > 3h → auto-PAUSE it
//      (not cancel), so the 7-day paused grace protects it. Runs before
//      pass 2 so an in-progress match never reaches the 24h idle-cancel.
//   2. Any non-terminal state (excluding PAUSED) with updatedAt > 24h
//      ago → cancel as 'abandoned'. Catches ghosted setups (pre-game-1)
//      that pass 1b intentionally skips. PAUSED gets its grace via pass 3.
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
import { applyPendingMatchMmr } from "./mmr-live.js";
import { sweepQueueMatches } from "./league-queue.js";
import { tryGetDiscordClient } from "./discord.js";
import { renderMatch } from "./match-render.js";
import type { MatchSession } from "@prisma/client";

const SWEEP_INTERVAL_MS = 60 * 1000;
const IDLE_CANCEL_HOURS = 24;
const PAUSED_CANCEL_DAYS = 7;
// A match that's actually UNDERWAY (a game has started) idle this long gets
// auto-PAUSED instead of left for the 24h idle-cancel — pausing preserves it
// (7-day grace) so a match players walked away from mid-game isn't destroyed.
const AUTO_PAUSE_HOURS = 3;
// "A game has started" = playing game 1, or anywhere in games 2/3. Deliberately
// excludes the pre-game-1 ban/pick SETUP and the unaccepted WAITING_ACCEPT invite
// (those keep their existing expiry / 24h-idle handling), plus PAUSED/terminal.
const IN_PROGRESS_STATES: MatchSession["state"][] = [
  "GAME_1_PLAYING",
  "GAME_2_CHOOSE_FIRST",
  "GAME_2_BAN",
  "GAME_2_PICK",
  "GAME_2_PLAYING",
  "GAME_3_CHOOSE_FIRST",
  "GAME_3_BAN",
  "GAME_3_PICK",
  "GAME_3_PLAYING",
];

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

// Re-render a just-paused session's live message to the paused UI (so the
// Resume button appears) and ping both players — Discord doesn't notify on edits,
// so the ping is what actually tells them to come back. Best-effort: any failure
// is logged and swallowed (the DB pause already protected the match).
async function notifyAutoPaused(session: MatchSession): Promise<void> {
  const client = tryGetDiscordClient();
  if (!client) return;
  const channelId = session.threadId ?? session.channelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("send" in channel) || !("messages" in channel)) return;
  const [playerA, playerB] = await Promise.all([
    prisma.player.findUnique({ where: { id: session.playerAId } }),
    prisma.player.findUnique({ where: { id: session.playerBId } }),
  ]);
  if (!playerA || !playerB) return;
  if (session.matchMessageId) {
    try {
      const { content, embeds, components } = renderMatch(session, playerA, playerB);
      await channel.messages.edit(session.matchMessageId, { content, embeds, components });
    } catch (err) {
      logDiscordError("match-sweep.auto-pause.render", err, { sessionId: session.id, threadId: channelId });
    }
  }
  await channel
    .send({
      content:
        `⏸️ <@${playerA.discordId}> <@${playerB.discordId}> — this match was **auto-paused** after ` +
        `${AUTO_PAUSE_HOURS}h with no activity so it doesn't get cancelled. When you're both back, hit ` +
        `**Resume** on the match message above (or just report your result). It'll stay paused for up ` +
        `to ${PAUSED_CANCEL_DAYS} days.`,
    })
    .catch((err) => logDiscordError("match-sweep.auto-pause.notify", err, { sessionId: session.id, threadId: channelId }));
}

// Auto-pause matches that are actually underway (a game has started) but idle for
// AUTO_PAUSE_HOURS+. Instead of letting them ride to the 24h idle-cancel, pause
// them — exactly like a manual pause (pausedFromState so Resume restores the
// phase) — so the 7-day paused grace protects them. Catches the common "played
// but forgot to report the winner, then walked away" case.
export async function sweepAutoPauseIdle(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_PAUSE_HOURS * 60 * 60 * 1000);
  const idle = await prisma.matchSession.findMany({
    where: {
      state: { in: IN_PROGRESS_STATES },
      updatedAt: { lt: cutoff },
    },
    take: 50,
  });
  if (idle.length === 0) return 0;

  let paused = 0;
  for (const session of idle) {
    // ATOMIC guard: only pause if the session is STILL idle + in the same
    // in-progress phase at write time. If a player reported (or the match
    // advanced/completed) in the gap since the SELECT, updatedAt is now recent
    // and/or the state changed, so this matches 0 rows and we skip it. Without
    // this, a blind update could clobber a just-completed match back to PAUSED —
    // players then resume and replay it, overwriting the recorded games.
    const res = await prisma.matchSession
      .updateMany({
        where: { id: session.id, updatedAt: { lt: cutoff }, state: { in: IN_PROGRESS_STATES } },
        data: {
          state: "PAUSED",
          pausedFromState: session.state,
          pausedAt: new Date(),
          pauseInitiatorPlayerId: null,
          resumeInitiatorPlayerId: null,
          version: { increment: 1 },
        },
      })
      .catch((err) => {
        console.warn(`[match-sweep auto-pause] pause ${session.id} failed:`, err);
        return { count: 0 };
      });
    if (res.count === 0) continue; // advanced by a player in the gap — leave it alone
    paused++;
    const fresh = await prisma.matchSession.findUnique({ where: { id: session.id } });
    if (fresh) await notifyAutoPaused(fresh);
  }
  console.log(`[match-sweep auto-pause] paused ${paused} idle in-progress session(s) (>${AUTO_PAUSE_HOURS}h)`);
  return paused;
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

  let cancelled = 0;
  for (const session of stale) {
    // ATOMIC guard (see sweepAutoPauseIdle): only cancel if the session is STILL
    // idle + non-terminal at write time, so a match a player just advanced or
    // completed in the gap since the SELECT isn't clobbered to CANCELLED.
    const res = await prisma.matchSession
      .updateMany({
        where: {
          id: session.id,
          updatedAt: { lt: cutoff },
          state: { notIn: ["COMPLETE", "CANCELLED", "PAUSED"] },
        },
        data: { state: "CANCELLED", version: { increment: 1 } },
      })
      .catch((err) => {
        console.warn(`[match-sweep idle] cancel ${session.id} failed:`, err);
        return { count: 0 };
      });
    if (res.count === 0) continue;
    cancelled++;
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
  console.log(`[match-sweep idle] cancelled ${cancelled} abandoned session(s) (>${IDLE_CANCEL_HOURS}h stale)`);
  return cancelled;
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

  let cancelled = 0;
  for (const session of stale) {
    // ATOMIC guard: only cancel if it's STILL a stale PAUSED session. If someone
    // resumed (and maybe completed) it in the gap since the SELECT, state is no
    // longer PAUSED, so this matches 0 rows and we leave it alone.
    const res = await prisma.matchSession
      .updateMany({
        where: { id: session.id, state: "PAUSED", pausedAt: { lt: cutoff } },
        data: { state: "CANCELLED", version: { increment: 1 } },
      })
      .catch((err) => {
        console.warn(`[match-sweep paused] cancel ${session.id} failed:`, err);
        return { count: 0 };
      });
    if (res.count === 0) continue;
    cancelled++;
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
  console.log(`[match-sweep paused] cancelled ${cancelled} paused session(s) (>${PAUSED_CANCEL_DAYS}d paused)`);
  return cancelled;
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
        const content = `🃏 **${label}** is now live! Run /schedule to see your matchups and /start-match to play. Good luck.`;
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
  sweepAutoPauseIdle().catch((err) => console.warn("[match-sweep] boot auto-pause sweep failed:", err));
  sweepIdleSessions().catch((err) => console.warn("[match-sweep] boot idle sweep failed:", err));
  sweepPausedSessions().catch((err) => console.warn("[match-sweep] boot paused sweep failed:", err));
  sweepLeakedThreads().catch((err) => console.warn("[match-sweep] boot leaked sweep failed:", err));
  sweepScheduledStarts().catch((err) => console.warn("[match-sweep] boot scheduled-start sweep failed:", err));
  applyPendingMatchMmr()
    .then((n) => n > 0 && console.log(`[match-sweep mmr] applied ${n} match(es)`))
    .catch((err) => console.warn("[match-sweep] boot mmr apply failed:", err));
  sweepQueueMatches()
    .then((n) => n > 0 && console.log(`[match-sweep queue] started ${n} queued match(es)`))
    .catch((err) => console.warn("[match-sweep] boot queue sweep failed:", err));
  setInterval(() => {
    sweepExpiredInvites().catch((err) => console.warn("[match-sweep] expiry tick failed:", err));
    sweepAutoPauseIdle().catch((err) => console.warn("[match-sweep] auto-pause tick failed:", err));
    sweepIdleSessions().catch((err) => console.warn("[match-sweep] idle tick failed:", err));
    sweepPausedSessions().catch((err) => console.warn("[match-sweep] paused tick failed:", err));
    sweepLeakedThreads().catch((err) => console.warn("[match-sweep] leaked tick failed:", err));
    sweepScheduledStarts().catch((err) => console.warn("[match-sweep] scheduled-start tick failed:", err));
    applyPendingMatchMmr()
      .then((n) => n > 0 && console.log(`[match-sweep mmr] applied ${n} match(es)`))
      .catch((err) => console.warn("[match-sweep] mmr apply tick failed:", err));
    sweepQueueMatches()
      .then((n) => n > 0 && console.log(`[match-sweep queue] started ${n} queued match(es)`))
      .catch((err) => console.warn("[match-sweep] queue sweep tick failed:", err));
  }, SWEEP_INTERVAL_MS);
}
