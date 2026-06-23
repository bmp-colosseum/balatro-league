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

// The pinned message's content + Join/Leave buttons + the live "free right now"
// list. allowedMentions is cleared so editing the message on every join/leave
// never re-pings anyone.
function renderQueueMessage(players: Player[]): BaseMessageOptions {
  const lines = [
    "## 🎮 League Queue",
    "Hit **Queue up** when you're around to play. The moment an opponent you're scheduled against is also in the queue, I'll open a match invite for you both to accept.",
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
    update: { seasonId }, // re-queueing refreshes the season scope; keep original queuedAt
  });
}

export async function leaveQueue(playerId: string): Promise<boolean> {
  const res = await prisma.queueEntry.deleteMany({ where: { playerId } });
  return res.count > 0;
}

export async function isQueued(playerId: string): Promise<boolean> {
  return (await prisma.queueEntry.count({ where: { playerId } })) > 0;
}

// Is the player currently in a non-terminal match session (waiting/playing/paused)?
export async function playerInActiveMatch(playerId: string): Promise<boolean> {
  const n = await prisma.matchSession.count({
    where: {
      state: { notIn: ["COMPLETE", "CANCELLED"] },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  return n > 0;
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
  const entries = await prisma.queueEntry.findMany({
    where: { seasonId: season.id },
    orderBy: { queuedAt: "asc" },
    select: { playerId: true },
  });
  if (entries.length < 2) return 0;

  const client = getDiscordClient();
  let started = 0;
  for (const { playerId } of entries) {
    // tryStartFromQueue removes both players on a match, so skip anyone already
    // paired earlier in this pass.
    if (!(await isQueued(playerId))) continue;
    const me = await prisma.player.findUnique({ where: { id: playerId } });
    if (!me) continue;
    const outcome = await tryStartFromQueue({ client, me, actor: SYSTEM_ACTOR });
    if (outcome.matched) started++;
  }
  if (started > 0) await refreshQueueMessage(client);
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
