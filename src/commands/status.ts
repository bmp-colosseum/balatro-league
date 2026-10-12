import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { formatSeasonLabel } from "../format-season.js";
import { computeStandings } from "../standings.js";
import { sanitizeName } from "../sanitize.js";
import { handleOf } from "../mention.js";
import type { SlashCommand } from "./types.js";

// Plain-data snapshot of "where a player stands right now" — the shared core
// behind /status, the "My standings" control button, AND the DM panel
// (../dm-panel.ts). Computed ONCE from the DB (computeStatusSummaryForPlayer);
// each surface renders it differently (a full embed here, a few compact lines
// there) without re-deriving standings.
export interface PlayerStatusSummary {
  kind: "no-season" | "no-division" | "no-standings-row" | "ok";
  // Populated for every non-"ok" kind — the ready-to-show explanation.
  message?: string;
  seasonLabel?: string;
  divisionName?: string;
  // The division's Discord channel, so surfaces like the DM panel can link
  // straight to it. Null when the division has no channel provisioned yet.
  divisionChannelId?: string | null;
  tierName?: string;
  rank?: number;
  totalInDivision?: number;
  points?: number;
  wins?: number;
  draws?: number;
  losses?: number;
  played?: number;
  // Pre-rendered promotion/relegation/safe line — see describeMovement.
  movement?: string;
  remainingOpponents?: string[];
  // Parallel to remainingOpponents (same index = same opponent) -- each
  // entry is "@handle" or "" when the opponent has no synced/shown
  // username. Discord mentions often render as "unknown user" in a DM, so
  // player-facing surfaces that list opponents by name (the DM panel) pair
  // the name with a typed handle the way mentionWithHandle/handleOf do
  // everywhere else. Optional + parallel (not a richer remainingOpponents
  // entry) so existing consumers of the plain string[] are unaffected.
  remainingOpponentHandles?: string[];
}

// Promotion/relegation position: the top `promote` finishers move up a
// division next season, the bottom `relegate` move down (both 0 at the
// top/bottom of the ladder). Pure — exported so it's unit-testable without
// touching the DB.
// Singular/plural agreement for the promote/relegate parenthetical -- "top 1
// promote" read as a typo (see B06 in .claude/knowledge/bot-ux/01-findings.md).
const promoteWord = (promote: number): string => (promote === 1 ? "the top finisher promotes" : `top ${promote} promote`);
const relegateWord = (relegate: number): string => (relegate === 1 ? "last place relegates" : `bottom ${relegate} relegate`);

export function describeMovement(rank: number, total: number, promote: number, relegate: number): string {
  if (promote > 0 && rank <= promote) {
    return `🔼 **Promotion spot** - on track to move up next season (${promoteWord(promote)}). Hold it!`;
  }
  if (relegate > 0 && rank > total - relegate) {
    return `🔽 **Relegation spot** - on track to drop next season (${relegateWord(relegate)}). Climb out!`;
  }
  const parts: string[] = [];
  if (promote > 0) parts.push(promoteWord(promote));
  if (relegate > 0) parts.push(relegateWord(relegate));
  return `✅ **Safe** - holding your spot` + (parts.length ? ` (${parts.join(", ")})` : "");
}

// Gather + decide: the one DB round-trip every caller (slash command, button,
// DM panel refresh) shares. Takes a bare playerId (no Discord User needed) so
// the DM panel refresh loop — which already has Player rows from a
// division-member walk — never has to re-fetch/create a Player per tick.
export async function computeStatusSummaryForPlayer(playerId: string): Promise<PlayerStatusSummary> {
  const activeSeason = await activePublicSeason();
  if (!activeSeason) return { kind: "no-season", message: "No active season right now." };

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, status: "ACTIVE", division: { seasonId: activeSeason.id } },
    include: {
      division: {
        include: {
          tier: true,
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          matches: {
            where: { format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, status: true },
          },
        },
      },
    },
  });
  if (!membership) {
    return {
      kind: "no-division",
      message: "You're not in a division this season. Once you're placed, click **Who do I play?** in your division channel to see your matches.",
    };
  }

  const div = membership.division;
  const confirmed = div.matches.filter((m) => m.status === "CONFIRMED");
  const rows = computeStandings(div.members.map((m) => m.player), confirmed);
  const myRow = rows.find((r) => r.player.id === playerId);
  if (!myRow) {
    return {
      kind: "no-standings-row",
      message: `You're in **${div.name}**, but no standings row yet — play a match and it'll show up.`,
    };
  }
  const rank = myRow.rank ?? rows.findIndex((r) => r.player.id === playerId) + 1;
  const movement = describeMovement(rank, rows.length, div.promoteCount ?? 0, div.relegateCount ?? 0);

  // Opponents still to play = your pre-created matchups that haven't been played
  // yet (PENDING + 0-0). Mirrors /schedule's "still to play".
  const nameById = new Map(div.members.map((m) => [m.player.id, m.player.displayName]));
  // Player rows are already joined (div.members include: { player: true }
  // above) -- no extra query needed to pair each name with its handle.
  const handleById = new Map(div.members.map((m) => [m.player.id, handleOf(m.player)]));
  const remainingOpponentIds = div.matches
    .filter(
      (m) =>
        (m.playerAId === playerId || m.playerBId === playerId) &&
        m.status === "PENDING" &&
        m.gamesWonA === 0 &&
        m.gamesWonB === 0,
    )
    .map((m) => (m.playerAId === playerId ? m.playerBId : m.playerAId));
  const remainingOpponents = remainingOpponentIds.map((id) => sanitizeName(nameById.get(id) ?? "?"));
  const remainingOpponentHandles = remainingOpponentIds.map((id) => handleById.get(id) ?? "");

  return {
    kind: "ok",
    seasonLabel: formatSeasonLabel(activeSeason),
    divisionName: div.name,
    divisionChannelId: div.discordChannelId,
    tierName: div.tier.name,
    rank,
    totalInDivision: rows.length,
    points: myRow.points,
    wins: myRow.wins,
    draws: myRow.draws,
    losses: myRow.losses,
    played: myRow.played,
    movement,
    remainingOpponents,
    remainingOpponentHandles,
  };
}

function summaryToReply(summary: PlayerStatusSummary): { content?: string; embeds?: EmbedBuilder[] } {
  if (summary.kind !== "ok") return { content: summary.message };
  const remaining = summary.remainingOpponents ?? [];
  const embed = new EmbedBuilder()
    .setTitle(`Your status — ${summary.divisionName}`)
    .setColor(0x5865f2)
    .setDescription(
      `**${summary.seasonLabel}** · ${summary.tierName} tier\n\n` +
        `🏅 **#${summary.rank}** of ${summary.totalInDivision}\n` +
        `**${summary.points}** pts · ${summary.wins}W · ${summary.draws}D · ${summary.losses}L  _(${summary.played} played)_\n\n` +
        `${summary.movement}\n\n` +
        (remaining.length
          ? `🎮 **${remaining.length} left to play:** ${remaining.join(", ")}`
          : "✅ All your matches are done!"),
    );
  return { embeds: [embed] };
}

// Shared core for /status + the division control-panel "My standings" button:
// the caller's division, rank, points, record, and who's left to play. Returns a
// ready reply payload — { content } for the not-in-season cases, { embeds } for
// the status card — so both a slash command and a button can editReply it.
export async function buildStatusReply(
  user: User,
  guildName: string | undefined,
): Promise<{ content?: string; embeds?: EmbedBuilder[] }> {
  const me = await getOrCreatePlayer(user, guildName);
  const summary = await computeStatusSummaryForPlayer(me.id);
  return summaryToReply(summary);
}

// /status — "where do I stand right now": your division, rank, points, record.
// The standing half of the picture; /schedule is the matches half.
export const status: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Where you stand this season — your division, rank, points, and record."),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await buildStatusReply(interaction.user, guildDisplayName(interaction)));
  },
};
