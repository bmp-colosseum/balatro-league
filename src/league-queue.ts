import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type TextChannel,
  type BaseMessageOptions,
} from "discord.js";
import type { Player } from "@prisma/client";
import { prisma } from "./db.js";
import { activePublicSeason } from "./active-season.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { createLeagueMatchInvite } from "./league-match-invite.js";
import { recordAudit, SYSTEM_ACTOR } from "./audit.js";
import { getDiscordClient } from "./discord.js";

// A queue entry auto-expires after this long without the player re-queueing.
// Past ~12h idle it's near-certain they're no longer around, and a stale entry
// is worse than none (an opponent "matches" a ghost). Clicking Queue up again
// resets the clock (see joinQueue).
export const QUEUE_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// Pure: has this entry gone idle past the timeout? Injectable now/timeout keep it
// unit-testable without a clock.
export function isQueueEntryExpired(
  queuedAt: Date,
  now: Date,
  timeoutMs: number = QUEUE_IDLE_TIMEOUT_MS,
): boolean {
  return now.getTime() - queuedAt.getTime() >= timeoutMs;
}

// The pinned message's content + Join/Leave buttons + the live "free right now"
// list. allowedMentions is cleared so editing the message on every join/leave
// never re-pings anyone.
function renderQueueMessage(players: Player[]): BaseMessageOptions {
  const lines = [
    "## 🎮 League Queue",
    "Hit **Queue up** when you're around to play. The moment an opponent you're scheduled against is also in the queue, I'll open a match invite for you both to accept.",
    "",
    "⚠️ **This is a convenience, not a scheduler.** Getting your matches played is still **your responsibility** — reach out to your opponents directly. The queue only helps for the moments you both happen to be free at once.",
    "",
    players.length
      ? `**In the queue (${players.length}):** ${players.map((p) => p.displayName).join(", ")}`
      : "_Queue is empty right now._",
  ];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("queue:join").setLabel("Queue up").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("queue:leave").setLabel("Leave queue").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("queue:status").setLabel("Status").setStyle(ButtonStyle.Secondary),
  );
  return { content: lines.join("\n"), components: [row], allowedMentions: { parse: [] } };
}

// Players currently queued for the season, in the order they joined.
async function currentlyQueued(seasonId: string): Promise<Player[]> {
  const entries = await prisma.queueEntry.findMany({
    where: { seasonId },
    orderBy: { queuedAt: "asc" },
    select: { playerId: true },
  });
  if (entries.length === 0) return [];
  const players = await prisma.player.findMany({ where: { id: { in: entries.map((e) => e.playerId) } } });
  const byId = new Map(players.map((p) => [p.id, p]));
  return entries.map((e) => byId.get(e.playerId)).filter((p): p is Player => !!p);
}

export async function joinQueue(playerId: string, seasonId: string): Promise<void> {
  await prisma.queueEntry.upsert({
    where: { playerId },
    create: { playerId, seasonId },
    // Re-queueing is an "I'm around now" signal: refresh the season scope AND
    // reset queuedAt so the idle-expiry clock starts over (also re-orders to the
    // back of the barely-relevant, opponent-specific matching line).
    update: { seasonId, queuedAt: new Date() },
  });
}

export async function leaveQueue(playerId: string): Promise<boolean> {
  const res = await prisma.queueEntry.deleteMany({ where: { playerId } });
  return res.count > 0;
}

export async function isQueued(playerId: string): Promise<boolean> {
  return (await prisma.queueEntry.count({ where: { playerId } })) > 0;
}

// Is the player an ACTIVE member of a division in this season (i.e. in the league)?
export async function isInActiveDivision(playerId: string, seasonId: string): Promise<boolean> {
  const n = await prisma.divisionMember.count({ where: { playerId, status: "ACTIVE", seasonId } });
  return n > 0;
}

// How many scheduled-but-unplayed league matches the player still has this season.
export async function remainingMatchCount(playerId: string, seasonId: string): Promise<number> {
  return prisma.match.count({
    where: {
      status: "PENDING",
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      division: { seasonId },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
}

// Remove queue entries for anyone no longer eligible — idle past the expiry
// window, not an ACTIVE division member this season (not in the league), or with
// no scheduled matches left. Mirrors the Queue-up gate; runs each sweep so the
// queue self-cleans. `now` is injectable for tests. Returns how many were removed.
export async function pruneIneligibleQueue(seasonId: string, now: Date = new Date()): Promise<number> {
  const entries = await prisma.queueEntry.findMany({ select: { playerId: true, queuedAt: true } });
  if (entries.length === 0) return 0;
  const queuedIds = entries.map((e) => e.playerId);
  const members = await prisma.divisionMember.findMany({
    where: { seasonId, status: "ACTIVE", playerId: { in: queuedIds } },
    select: { playerId: true },
  });
  const memberSet = new Set(members.map((m) => m.playerId));
  const toRemove: string[] = [];
  for (const e of entries) {
    const id = e.playerId;
    if (isQueueEntryExpired(e.queuedAt, now)) {
      toRemove.push(id); // idle too long — almost certainly gone
      continue;
    }
    if (!memberSet.has(id)) {
      toRemove.push(id); // not in the league this season
      continue;
    }
    if ((await remainingMatchCount(id, seasonId)) === 0) toRemove.push(id); // nothing left to play
  }
  if (toRemove.length === 0) return 0;
  const res = await prisma.queueEntry.deleteMany({ where: { playerId: { in: toRemove } } });
  return res.count;
}

export interface QueueStatus {
  queued: boolean;
  free: Player[]; // everyone currently free (excluding the asker)
  remainingOpponents: Player[]; // the asker's still-to-play opponents this season
  freeOpponents: Player[]; // remainingOpponents who are free right now
}

// A snapshot for one player: are they queued, who's free, who they still have to
// play, and which of those opponents are free right now.
export async function queueStatusFor(playerId: string, seasonId: string): Promise<QueueStatus> {
  const [queued, freeAll] = await Promise.all([isQueued(playerId), currentlyQueued(seasonId)]);
  const free = freeAll.filter((p) => p.id !== playerId);
  const pending = await prisma.match.findMany({
    where: {
      status: "PENDING",
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      division: { seasonId },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { playerAId: true, playerBId: true },
  });
  const oppIds = [...new Set(pending.map((m) => (m.playerAId === playerId ? m.playerBId : m.playerAId)))];
  const remainingOpponents = oppIds.length
    ? await prisma.player.findMany({ where: { id: { in: oppIds } } })
    : [];
  const freeIds = new Set(free.map((p) => p.id));
  const freeOpponents = remainingOpponents.filter((p) => freeIds.has(p.id));
  return { queued, free, remainingOpponents, freeOpponents };
}

// Find a player this one is scheduled against (PENDING, unplayed LEAGUE_BO2 in
// the active season) who is ALSO currently queued. Returns the opponent + their
// shared division id, or null.
async function findQueuedOpponent(
  playerId: string,
  seasonId: string,
): Promise<{ opp: Player; divisionId: string } | null> {
  const pending = await prisma.match.findMany({
    where: {
      status: "PENDING",
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      division: { seasonId },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { divisionId: true, playerAId: true, playerBId: true },
  });
  if (pending.length === 0) return null;
  const oppIdToDivision = new Map<string, string>();
  for (const m of pending) {
    const oppId = m.playerAId === playerId ? m.playerBId : m.playerAId;
    if (!oppIdToDivision.has(oppId)) oppIdToDivision.set(oppId, m.divisionId);
  }
  const queuedOpp = await prisma.queueEntry.findFirst({
    where: { playerId: { in: [...oppIdToDivision.keys()] } },
    orderBy: { queuedAt: "asc" },
  });
  if (!queuedOpp) return null;
  const opp = await prisma.player.findUnique({ where: { id: queuedOpp.playerId } });
  if (!opp) return null;
  return { opp, divisionId: oppIdToDivision.get(opp.id)! };
}

export interface QueueMatchOutcome {
  matched: boolean;
  oppName?: string;
  inviteUrl?: string | null;
  error?: string; // set when a match was found but the invite couldn't be created
}

// On join: if a scheduled opponent is already queued, fire the normal match
// invite (same path as /start-match) and remove BOTH from the queue.
export async function tryStartFromQueue(opts: {
  client: Client;
  me: Player;
  actor: Parameters<typeof recordAudit>[0]["actor"];
}): Promise<QueueMatchOutcome> {
  const season = await activePublicSeason();
  if (!season) return { matched: false };
  const found = await findQueuedOpponent(opts.me.id, season.id);
  if (!found) return { matched: false };

  const channelId = (await getConfig(LeagueConfigKey.LeagueQueueChannelId)) ?? "";
  const result = await createLeagueMatchInvite({
    client: opts.client,
    season: { id: season.id },
    division: { id: found.divisionId },
    me: opts.me,
    opp: found.opp,
    channelId,
    source: "queue",
    actor: opts.actor,
  });
  if (!result.ok) return { matched: false, error: result.error };

  await prisma.queueEntry.deleteMany({ where: { playerId: { in: [opts.me.id, found.opp.id] } } });
  return { matched: true, oppName: found.opp.displayName, inviteUrl: result.inviteUrl };
}

// Safety-net matcher. Matching is normally event-driven (the second player to
// hit Queue up triggers it instantly), so this usually finds nothing — it just
// catches the rare miss: a transient invite-create failure, or two opponents who
// ended up queued without pairing. Cheap: bails immediately on <2 queued. Run
// from the existing match-sweep tick, so it adds no new loop.
export async function sweepQueueMatches(): Promise<number> {
  const season = await activePublicSeason();
  if (!season) return 0;
  const client = getDiscordClient();

  // First, drop anyone no longer eligible (left the league, finished their
  // matches) so the queue stays clean even between clicks.
  const pruned = await pruneIneligibleQueue(season.id);

  const entries = await prisma.queueEntry.findMany({
    where: { seasonId: season.id },
    orderBy: { queuedAt: "asc" },
    select: { playerId: true },
  });
  let started = 0;
  if (entries.length >= 2) {
    for (const { playerId } of entries) {
      // tryStartFromQueue removes both players on a match, so skip anyone already
      // paired earlier in this pass.
      if (!(await isQueued(playerId))) continue;
      const me = await prisma.player.findUnique({ where: { id: playerId } });
      if (!me) continue;
      const outcome = await tryStartFromQueue({ client, me, actor: SYSTEM_ACTOR });
      if (outcome.matched) started++;
    }
  }
  if (pruned > 0 || started > 0) await refreshQueueMessage(client);
  return started;
}

// Re-render the pinned queue message in place.
export async function refreshQueueMessage(client: Client): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.LeagueQueueChannelId);
  const messageId = await getConfig(LeagueConfigKey.LeagueQueueMessageId);
  if (!channelId || !messageId) return;
  const season = await activePublicSeason();
  const players = season ? await currentlyQueued(season.id) : [];
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && ch.type === ChannelType.GuildText) {
      await (ch as TextChannel).messages.edit(messageId, renderQueueMessage(players));
    }
  } catch (err) {
    console.warn("[queue] refresh message failed:", err);
  }
}

// Post (or refresh) the pinned queue message in the given channel and store its
// id. Idempotent — called from bootstrap.
export async function ensureQueueMessage(client: Client, channelId: string): Promise<void> {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const tc = ch as TextChannel;
  const season = await activePublicSeason();
  const players = season ? await currentlyQueued(season.id) : [];
  const payload = renderQueueMessage(players);

  const existingId = await getConfig(LeagueConfigKey.LeagueQueueMessageId);
  if (existingId) {
    const ok = await tc.messages
      .edit(existingId, payload)
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  const sent = await tc.send(payload);
  await sent.pin().catch(() => {});
  await setConfig(LeagueConfigKey.LeagueQueueMessageId, sent.id, "system");
}

// ---- "Notify me when an opponent I owe a match queues" opt-in ---------------
//
// Per-player, default OFF, toggled via /notify. Stored in LeagueConfig under
// queue_notify:<playerId> (same raw-key pattern as dm_panel:<id>). The DM is the
// player's own explicit opt-in, so no dm_panels master switch gates it.

const queueNotifyKey = (playerId: string): string => `queue_notify:${playerId}`;

// Per-JOINER cooldown so queue churn (join / leave / re-queue) can't spam an
// opponent: one notify wave per joiner per window; re-queueing inside it stays
// silent. Stored as an ISO timestamp under queue_notify_last:<joinerId>.
export const QUEUE_NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h
const queueNotifyCooldownKey = (playerId: string): string => `queue_notify_last:${playerId}`;

export async function isQueueNotifyOptIn(playerId: string): Promise<boolean> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: queueNotifyKey(playerId) } });
  return row?.value === "1";
}

export async function setQueueNotifyOptIn(playerId: string, on: boolean): Promise<void> {
  const value = on ? "1" : "0";
  await prisma.leagueConfig.upsert({
    where: { key: queueNotifyKey(playerId) },
    create: { key: queueNotifyKey(playerId), value, updatedBy: "player" },
    update: { value, updatedBy: "player" },
  });
}

// DM every opted-in opponent the joiner still owes a match, when the joiner hits
// Queue up and DIDN'T instantly pair. Skips opponents already in the queue (they
// would have matched, or the sweep will pair them) and honors the per-joiner
// cooldown. Best-effort: a closed-DM failure is swallowed. Returns how many were
// actually DMed. Runs off the durable queue.notify-opponents job (see queue.ts).
export async function notifyOpponentsOfQueueJoin(
  joinerId: string,
  seasonId: string,
  client: Client,
): Promise<number> {
  // Cooldown gate: at most one wave per joiner per window.
  const lastRow = await prisma.leagueConfig.findUnique({ where: { key: queueNotifyCooldownKey(joinerId) } });
  const last = lastRow?.value ? Date.parse(lastRow.value) : NaN;
  if (!Number.isNaN(last) && Date.now() - last < QUEUE_NOTIFY_COOLDOWN_MS) return 0;

  const joiner = await prisma.player.findUnique({ where: { id: joinerId } });
  if (!joiner) return 0;

  // Opponents with a scheduled, unplayed match against the joiner this season.
  const pending = await prisma.match.findMany({
    where: {
      status: "PENDING",
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      division: { seasonId },
      OR: [{ playerAId: joinerId }, { playerBId: joinerId }],
    },
    select: { playerAId: true, playerBId: true },
  });
  const oppIds = [...new Set(pending.map((m) => (m.playerAId === joinerId ? m.playerBId : m.playerAId)))];
  if (oppIds.length === 0) return 0;

  // Opponents already queued would have matched (or the sweep will pair them) —
  // don't nudge them to do what's already happening.
  const queued = await prisma.queueEntry.findMany({
    where: { playerId: { in: oppIds } },
    select: { playerId: true },
  });
  const queuedSet = new Set(queued.map((q) => q.playerId));

  const channelId = (await getConfig(LeagueConfigKey.LeagueQueueChannelId)) ?? "";
  const queueLink = channelId ? `\nJump in here: <#${channelId}>` : "";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("queue:join").setLabel("Queue up").setStyle(ButtonStyle.Success),
  );

  let notified = 0;
  for (const oppId of oppIds) {
    if (queuedSet.has(oppId)) continue;
    if (!(await isQueueNotifyOptIn(oppId))) continue;
    const opp = await prisma.player.findUnique({ where: { id: oppId } });
    if (!opp?.discordId) continue;
    const user = await client.users.fetch(opp.discordId).catch(() => null);
    if (!user) continue;
    const ok = await user
      .send({
        content:
          `🔔 **${joiner.displayName}** just joined the league queue — you still have a match to play against them. ` +
          `Hit **Queue up** and you'll pair up instantly.` +
          queueLink,
        components: [row],
        allowedMentions: { parse: [] },
      })
      .then(() => true)
      .catch(() => false); // DMs closed -> skip
    if (ok) notified++;
  }

  // Only start the cooldown once a wave actually went out, so a join with no
  // opted-in opponents doesn't silently burn the window.
  if (notified > 0) {
    const nowIso = new Date().toISOString();
    await prisma.leagueConfig.upsert({
      where: { key: queueNotifyCooldownKey(joinerId) },
      create: { key: queueNotifyCooldownKey(joinerId), value: nowIso, updatedBy: "system" },
      update: { value: nowIso, updatedBy: "system" },
    });
  }
  return notified;
}
