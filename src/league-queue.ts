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
import { recordAudit } from "./audit.js";

// The pinned message's content + Join/Leave buttons + the live "free right now"
// list. allowedMentions is cleared so editing the message on every join/leave
// never re-pings anyone.
function renderQueueMessage(players: Player[]): BaseMessageOptions {
  const lines = [
    "## 🎮 League Queue",
    "Click **I'm free** when you're around to play. The moment an opponent you're scheduled against is also free, I'll open a match invite for you both to accept.",
    "",
    players.length
      ? `**Free right now (${players.length}):** ${players.map((p) => p.displayName).join(", ")}`
      : "_Nobody's in the queue right now._",
  ];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("queue:join").setLabel("I'm free").setStyle(ButtonStyle.Success).setEmoji("🎮"),
    new ButtonBuilder().setCustomId("queue:leave").setLabel("Leave").setStyle(ButtonStyle.Secondary),
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
