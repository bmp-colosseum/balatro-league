// /admin — admin-only tools that genuinely belong in Discord rather than
// the web dashboard, because admin context is the live chat:
// reading a dispute thread + deciding the result + recording it is one
// continuous flow there, vs context-switching to the web dashboard.
//
// All other admin functions (season setup, signups, division assignment,
// rankings, presets, etc.) live on www.balatroleague.com.

import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { announceResult } from "../announce.js";
import { prisma } from "../db.js";
import { buildLeagueExport, exportFilename, serializeExport } from "../league-export.js";
import { requireAdmin } from "../permissions.js";
import { getOrCreatePlayer } from "../players.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import type { SlashCommand } from "./types.js";

const RESULT_CHOICES = [
  { name: "2-0 (P1 won both)", value: "2-0" },
  { name: "1-1 (draw)", value: "1-1" },
  { name: "0-2 (P2 won both)", value: "0-2" },
] as const;

export const admin: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin tools that make sense in Discord context (dispute resolution).")
    .addSubcommand((sub) =>
      sub
        .setName("record-set")
        .setDescription("Manually record a CONFIRMED set (e.g. agreed verbally, never reported).")
        .addUserOption((opt) => opt.setName("p1").setDescription("Player 1").setRequired(true))
        .addUserOption((opt) => opt.setName("p2").setDescription("Player 2").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("result")
            .setDescription("Result from P1's POV")
            .setRequired(true)
            .addChoices(...RESULT_CHOICES),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why (e.g. 'agreed in DMs', 'shootout', 'dispute resolution')")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("override-result")
        .setDescription("Force-resolve a disputed set with the correct result.")
        .addStringOption((opt) =>
          opt.setName("set-id").setDescription("ID of the disputed set (from the dispute embed)").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("result")
            .setDescription("Result from playerA's POV")
            .setRequired(true)
            .addChoices(...RESULT_CHOICES),
        )
        .addStringOption((opt) => opt.setName("reason").setDescription("Why").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("join-match")
        .setDescription("Add yourself to a private match channel to mediate a dispute.")
        .addStringOption((opt) =>
          opt
            .setName("match-id")
            .setDescription("Match session ID — shown in the embed footer as 'Match {id}'")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("export-results")
        .setDescription("Dump the league's restorable state as a JSON file attachment."),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireAdmin(interaction))) return;
    const sub = interaction.options.getSubcommand();
    if (sub === "record-set") return recordPairing(interaction);
    if (sub === "override-result") return forceResult(interaction);
    if (sub === "join-match") return joinMatch(interaction);
    if (sub === "export-results") return exportResults(interaction);
  },
};

// Build a fresh league snapshot and post it as an ephemeral attachment
// reply so only the admin who ran the command sees the file. The weekly
// cron-driven backup posts publicly to bot-commands; this command is
// for ad-hoc dumps without spamming the channel.
async function exportResults(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const data = await buildLeagueExport();
    const buf = serializeExport(data);
    const filename = exportFilename();
    const attachment = new AttachmentBuilder(buf, { name: filename });
    await interaction.editReply({
      content:
        `📦 League snapshot: ${data.seasons.length} seasons, ${data.players.length} players, ` +
        `${data.seasons.reduce((sum, s) => sum + s.divisions.reduce((d, dv) => d + dv.pairings.length, 0), 0)} pairings. ` +
        `File size ${(buf.length / 1024).toFixed(1)}KB.`,
      files: [attachment],
    });
  } catch (err) {
    console.warn("[admin export-results] failed:", err);
    await interaction.editReply("Export failed — check bot logs.");
  }
}

// Add the calling admin to a specific match channel's permission overwrites.
// Match channels are private (only the 2 players see them by default), so
// when a dispute comes in admin needs to opt themselves in. Players share
// the match-id from the embed footer; admin pastes it here.
async function joinMatch(interaction: ChatInputCommandInteraction) {
  const matchId = interaction.options.getString("match-id", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = await prisma.matchSession.findUnique({ where: { id: matchId } });
  if (!session) {
    await interaction.editReply(`No match session found with id \`${matchId}\`.`);
    return;
  }
  if (!session.threadId) {
    await interaction.editReply("That match doesn't have a dedicated channel yet (not accepted).");
    return;
  }
  try {
    const channel = await interaction.client.channels.fetch(session.threadId);
    if (!channel) {
      await interaction.editReply("Match channel/thread doesn't exist anymore — it may have been deleted.");
      return;
    }
    if (channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread) {
      // Threads: add the admin as a member. Private Threads need explicit
      // membership; Public Threads they can already see but the message
      // confirms presence to players.
      await channel.members.add(interaction.user.id, `Admin ${interaction.user.username} mediating`);
      await channel.send(
        `🛠️ <@${interaction.user.id}> joined to mediate. Players: explain the situation here.`,
      );
    } else if (channel.type === ChannelType.GuildText) {
      // Legacy per-match text channels (pre-thread revert).
      const text = channel as TextChannel;
      await text.permissionOverwrites.edit(
        interaction.user.id,
        { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
        { reason: `Admin ${interaction.user.username} mediating` },
      );
      await text.send(
        `🛠️ <@${interaction.user.id}> joined to mediate. Players: explain the situation here.`,
      );
    } else {
      await interaction.editReply("Match channel type is unsupported (not a thread or text channel).");
      return;
    }
    await interaction.editReply(`Joined <#${session.threadId}>. Head over there to mediate.`);
  } catch (err) {
    console.warn("[admin join-match] failed:", err);
    await interaction.editReply("Couldn't join — check the bot has Manage Threads / Manage Channels.");
  }
  void PermissionFlagsBits;
}

async function recordPairing(interaction: ChatInputCommandInteraction) {
  const p1User = interaction.options.getUser("p1", true);
  const p2User = interaction.options.getUser("p2", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason") ?? undefined;
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({ content: `Invalid result \`${resultStr}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (p1User.id === p2User.id) {
    await interaction.reply({ content: "P1 and P2 must be different players.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const activeSeason = await prisma.season.findFirst({ where: { isActive: true } });
  if (!activeSeason) {
    await interaction.editReply("No active season.");
    return;
  }

  const p1 = await getOrCreatePlayer(p1User);
  const p2 = await getOrCreatePlayer(p2User);

  const shared = await prisma.divisionMember.findFirst({
    where: { playerId: p1.id, division: { seasonId: activeSeason.id } },
    include: { division: { include: { members: { where: { playerId: p2.id } } } } },
  });
  if (!shared || shared.division.members.length === 0) {
    await interaction.editReply(
      `${p1User.username} and ${p2User.username} aren't in the same division this season.`,
    );
    return;
  }
  const division = shared.division;

  const [playerAId, playerBId] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  const p1IsA = p1.id === playerAId;
  const games = gamesFromResult(result);
  const gamesWonA = p1IsA ? games.a : games.b;
  const gamesWonB = p1IsA ? games.b : games.a;

  const upserted = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId } },
    create: {
      divisionId: division.id,
      playerAId,
      playerBId,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reporterId: null,
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason ?? "admin record-set",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason ?? "admin record-set (overwrite)",
    },
  });
  announceResult(upserted.id).catch(() => {});
  recomputeDivisionStandings(division.id).catch(() => {});

  await interaction.editReply(
    `Recorded: **${p1User.username} ${games.a}-${games.b} ${p2User.username}** in **${division.name}**.` +
      (reason ? `\nReason: ${reason}` : ""),
  );
}

async function forceResult(interaction: ChatInputCommandInteraction) {
  const pairingId = interaction.options.getString("set-id", true);
  const resultStr = interaction.options.getString("result", true);
  const reason = interaction.options.getString("reason", true);
  const result = parsePairingResult(resultStr);

  if (!result) {
    await interaction.reply({ content: `Invalid result \`${resultStr}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: true },
  });
  if (!pairing) {
    await interaction.editReply(`No set with id \`${pairingId}\`.`);
    return;
  }

  const games = gamesFromResult(result);
  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason,
    },
  });
  announceResult(pairingId).catch(() => {});
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});

  await interaction.editReply(
    `Force-resolved: **${pairing.playerA.displayName} ${games.a}-${games.b} ${pairing.playerB.displayName}** in **${pairing.division.name}**.\nReason: ${reason}`,
  );
}
