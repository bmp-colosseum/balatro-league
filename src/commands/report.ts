import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer } from "../players.js";
import { confirmSet, disputeSet, reportSet } from "../reporting.js";
import { gamesFromResult, parsePairingResult } from "../scoring.js";
import type { ButtonHandler, SlashCommand } from "./types.js";

const RESULT_CHOICES = [
  { name: "2-0 (I won both games)", value: "2-0" },
  { name: "1-1 (we drew)", value: "1-1" },
  { name: "0-2 (I lost both games)", value: "0-2" },
] as const;

export const report: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("report")
    .setDescription("Report the result of your best-of-2 match against an opponent.")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you faced").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("result")
        .setDescription("Result from YOUR point of view")
        .setRequired(true)
        .addChoices(...RESULT_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    const resultStr = interaction.options.getString("result", true);
    const result = parsePairingResult(resultStr);

    if (!result) {
      await interaction.reply({
        content: `Invalid result \`${resultStr}\`. Use 2-0, 1-1, or 0-2.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (opponentUser.bot) {
      await interaction.reply({
        content: "Opponents must be real players, not bots.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const reporter = await getOrCreatePlayer(interaction.user);
    const opponent = await getOrCreatePlayer(opponentUser);

    const r = await reportSet({
      reporterPlayerId: reporter.id,
      opponentPlayerId: opponent.id,
      result,
    });
    if (!r.ok) {
      await interaction.editReply(r.reason);
      return;
    }

    const games = gamesFromResult(result);
    const division = await prisma.division.findFirst({
      where: { members: { some: { playerId: reporter.id } }, season: { isActive: true, visibility: "PUBLIC" } },
    });
    const displayed = `${games.a}-${games.b}`;
    const embed = new EmbedBuilder()
      .setTitle("✅ Match recorded")
      .setDescription(
        `<@${interaction.user.id}> **${displayed}** vs <@${opponentUser.id}>${division ? ` in **${division.name}**` : ""}.\n` +
          `_Doesn't look right? Ask an admin to use \`/admin override-result set-id:${r.pairingId}\`._`,
      )
      .setColor(0x2ecc71)
      .setFooter({ text: `Match ${r.pairingId}` });

    await interaction.editReply({ embeds: [embed] });
  },
};

// Button handler: customIds are "report:confirm:<pairingId>" or "report:dispute:<pairingId>"
export const reportButtons: ButtonHandler = {
  prefix: "report:",
  async execute(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const pairingId = parts[2];
    if (!pairingId || (action !== "confirm" && action !== "dispute")) {
      await interaction.reply({ content: "Malformed button id.", flags: MessageFlags.Ephemeral });
      return;
    }

    const actor = await getOrCreatePlayer(interaction.user);
    const r = action === "confirm"
      ? await confirmSet(pairingId, actor.id)
      : await disputeSet(pairingId, actor.id);

    if (!r.ok) {
      await interaction.reply({ content: r.reason, flags: MessageFlags.Ephemeral });
      return;
    }

    const pairing = await prisma.pairing.findUnique({
      where: { id: pairingId },
      include: { playerA: true, playerB: true, division: true },
    });
    if (!pairing) return;

    if (action === "confirm") {
      const display = `${pairing.gamesWonA}-${pairing.gamesWonB}`;
      const embed = new EmbedBuilder()
        .setTitle("Match confirmed")
        .setDescription(
          `<@${pairing.playerA.discordId}> **${display}** <@${pairing.playerB.discordId}>\n` +
            `Division: **${pairing.division.name}**`,
        )
        .setColor(0x2ecc71)
        .setFooter({ text: `Match ${pairing.id}` });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Match disputed")
      .setDescription(
        `<@${pairing.playerA.discordId}> vs <@${pairing.playerB.discordId}> in **${pairing.division.name}** — opponent disputed the reported result.\n` +
          "An admin needs to use `/admin override-result` to resolve this.",
      )
      .setColor(0xe74c3c)
      .setFooter({ text: `Match ${pairing.id}` });
    await interaction.update({ embeds: [embed], components: [] });
  },
};
