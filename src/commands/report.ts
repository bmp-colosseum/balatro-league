import {
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { announceResult } from "../announce.js";
import { prisma } from "../db.js";
import { spawnDisputeThread } from "../dispute-thread.js";
import { getOrCreatePlayer } from "../players.js";
import { enqueueReportAutoConfirm } from "../queue.js";
import { buildReportEmbed, postPendingReport } from "../report-flow.js";
import { confirmSet, disputeSet, reportSet } from "../reporting.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
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
    if (!["2-0", "1-1", "0-2"].includes(resultStr)) {
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const reporter = await getOrCreatePlayer(interaction.user);
    const opponent = await getOrCreatePlayer(opponentUser);

    const r = await reportSet({
      reporterPlayerId: reporter.id,
      opponentPlayerId: opponent.id,
      result: resultStr as "2-0" | "1-1" | "0-2",
    });
    if (!r.ok) {
      await interaction.editReply(r.reason);
      return;
    }

    // Post the public PENDING embed to #results + schedule the 2-min
    // auto-confirm fallback. If the post fails, auto-confirm still fires
    // from the pg-boss queue — reporter just doesn't get a confirm/dispute
    // button visible to the opponent.
    await postPendingReport(r.pairingId);
    await enqueueReportAutoConfirm(r.pairingId);

    await interaction.editReply(
      `📝 Reported. Your opponent has 2 minutes in #results to confirm or dispute — if they don't respond, it auto-confirms.`,
    );
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
      await interaction.reply({ content: "This button looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
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

    const reporterIsA = pairing.reporterId === pairing.playerAId;
    const reporter = reporterIsA ? pairing.playerA : pairing.playerB;
    const opponent = reporterIsA ? pairing.playerB : pairing.playerA;

    if (action === "confirm") {
      // confirmSet already wrote status=CONFIRMED + recompute. Fire the
      // announce here so the results-channel post + standings page
      // align. Edit the embed to drop the buttons and show outcome.
      announceResult(pairingId).catch(() => {});
      recomputeDivisionStandings(pairing.divisionId).catch(() => {});
      const embed = buildReportEmbed({
        status: "CONFIRMED",
        reporter,
        opponent,
        divisionName: pairing.division.name,
        result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
        reporterIsA,
        pairingId: pairing.id,
      });
      await interaction.update({ content: "", embeds: [embed], components: [] });
      return;
    }

    // Dispute: update embed in place + delegate thread spawn. The shared
    // spawnDisputeThread also fires from the web dispute flow.
    const embed = buildReportEmbed({
      status: "DISPUTED",
      reporter,
      opponent,
      divisionName: pairing.division.name,
      result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      reporterIsA,
      pairingId: pairing.id,
    });
    await interaction.update({ content: "", embeds: [embed], components: [] });
    spawnDisputeThread(pairing.id, { skipEmbedEdit: true }).catch((err) =>
      console.warn(`[report.dispute] thread spawn for ${pairingId}:`, err),
    );
  },
};
