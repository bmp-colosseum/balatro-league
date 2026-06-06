import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { enqueueAnnounceResult } from "../queue.js";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "../balatro-info.js";
import { prisma } from "../db.js";
import { spawnDisputeThread } from "../dispute-thread.js";
import { getOrCreatePlayer } from "../players.js";
import { enqueueReportAutoConfirm } from "../queue.js";
import { buildReportEmbed, postPendingReport } from "../report-flow.js";
import { confirmSet, disputeSet, reportSet } from "../reporting.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import type { ButtonHandler, ModalHandler, SelectMenuHandler, SlashCommand } from "./types.js";

const RESULT_CHOICES = [
  { name: "2-0 (I won both games)", value: "2-0" },
  { name: "1-1 (we drew)", value: "1-1" },
  { name: "0-2 (I lost both games)", value: "0-2" },
] as const;

export const report: SlashCommand = {
  // No channelScope — the ack reply is ephemeral and the public embed
  // gets posted to the resolved #results channel, so it's safe to run
  // from any channel.
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
    )
    .addStringOption((opt) =>
      opt
        .setName("deck")
        .setDescription("Optional: the deck that was played")
        .setRequired(false)
        .addChoices(...CANONICAL_DECKS.slice(0, 25).map((d) => ({ name: d.name, value: d.name }))),
    )
    .addStringOption((opt) =>
      opt
        .setName("stake")
        .setDescription("Optional: the stake that was played")
        .setRequired(false)
        .addChoices(...CANONICAL_STAKES.slice(0, 25).map((s) => ({ name: s.name, value: s.name }))),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    const resultStr = interaction.options.getString("result", true);
    const deck = interaction.options.getString("deck");
    const stake = interaction.options.getString("stake");
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
      deck,
      stake,
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

    // Dispute is a two-step flow: first an ephemeral select menu asks
    // what they think the result SHOULD be, then a modal collects the
    // reason. Two steps because Discord modals don't support select
    // menus — only text inputs — and we want a clean dropdown for the
    // proposed result instead of typed-and-validated text.
    if (action === "dispute") {
      // Only the two players in this match can dispute it — anyone else
      // shouldn't even get the outcome-selection menu.
      const subject = await prisma.pairing.findUnique({
        where: { id: pairingId },
        include: { playerA: { select: { discordId: true } }, playerB: { select: { discordId: true } } },
      });
      if (!subject) {
        await interaction.reply({ content: "This match isn't on record anymore.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (
        interaction.user.id !== subject.playerA.discordId &&
        interaction.user.id !== subject.playerB.discordId
      ) {
        await interaction.reply({
          content: "Only the two players in this match can dispute the result.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId(`dispute-select:${pairingId}`)
        .setPlaceholder("What SHOULD the result have been?")
        .addOptions(
          { label: "I won 2-0", value: "2-0" },
          { label: "It was a draw (1-1)", value: "1-1" },
          { label: "I lost 0-2", value: "0-2" },
          { label: "Not sure — let helper decide", value: "unsure" },
        );
      await interaction.reply({
        content: "Pick what you think the result should be — next step asks for the reason.",
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const actor = await getOrCreatePlayer(interaction.user);
    const r = await confirmSet(pairingId, actor.id);
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

    // confirmSet already wrote status=CONFIRMED + recompute. Fire the
    // announce here so the results-channel post + standings page
    // align. Edit the embed to drop the buttons and show outcome.
    enqueueAnnounceResult(pairingId).catch(() => {});
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
  },
};

// Dispute modal — just the reason text field. Proposed result is
// captured in the customId via the preceding select-menu step.
// Format: dispute-modal:<pairingId>:<proposal>
//   proposal is "2-0" | "1-1" | "0-2" | "unsure".
function buildDisputeModal(pairingId: string, proposal: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`dispute-modal:${pairingId}:${proposal}`)
    .setTitle("Why are you disputing?");
  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (helper will see this)")
    .setPlaceholder("Explain what's wrong with the reported result")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
  );
  return modal;
}

// Step 2 of the dispute flow: the user picked a proposed result from
// the dropdown the Dispute button posted. Open the reason-only modal,
// stashing their proposal in the modal's customId so the modal-submit
// handler knows what they picked.
export const disputeSelect: SelectMenuHandler = {
  prefix: "dispute-select:",
  async execute(interaction: StringSelectMenuInteraction) {
    const pairingId = interaction.customId.split(":")[1];
    const proposal = interaction.values[0];
    if (!pairingId || !proposal) {
      await interaction.reply({ content: "Pick a result from the dropdown.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildDisputeModal(pairingId, proposal));
  },
};

// Modal submit handler. customId format: dispute-modal:<pairingId>:<proposal>
//   proposal = "2-0" | "1-1" | "0-2" | "unsure"
// Parses the reason from the form, maps the proposal (from disputer's
// POV) to canonical A/B games-won, calls disputeSet.
export const disputeModal: ModalHandler = {
  prefix: "dispute-modal:",
  async execute(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(":");
    const pairingId = parts[1];
    const proposal = parts[2];
    if (!pairingId || !proposal) {
      await interaction.reply({ content: "Modal looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
      return;
    }
    const reason = interaction.fields.getTextInputValue("reason").trim();

    // Map disputer's proposal ('I won 2-0') to canonical A/B games-won.
    let proposedGamesWonA: number | undefined;
    let proposedGamesWonB: number | undefined;
    if (proposal !== "unsure") {
      const map: Record<string, { a: number; b: number }> = {
        "2-0": { a: 2, b: 0 },
        "1-1": { a: 1, b: 1 },
        "0-2": { a: 0, b: 2 },
      };
      const fromActorPov = map[proposal];
      if (!fromActorPov) {
        await interaction.reply({ content: "Invalid proposal.", flags: MessageFlags.Ephemeral });
        return;
      }
      const p = await prisma.pairing.findUnique({ where: { id: pairingId } });
      if (!p) {
        await interaction.reply({ content: "Match not found.", flags: MessageFlags.Ephemeral });
        return;
      }
      const actor = await getOrCreatePlayer(interaction.user);
      const actorIsA = p.playerAId === actor.id;
      proposedGamesWonA = actorIsA ? fromActorPov.a : fromActorPov.b;
      proposedGamesWonB = actorIsA ? fromActorPov.b : fromActorPov.a;
    }

    const actor = await getOrCreatePlayer(interaction.user);
    const r = await disputeSet(pairingId, actor.id, {
      reason: reason || undefined,
      proposedGamesWonA,
      proposedGamesWonB,
    });
    if (!r.ok) {
      await interaction.reply({ content: r.reason, flags: MessageFlags.Ephemeral });
      return;
    }
    // The modal is launched from the ephemeral dropdown reply, not
    // from the original announce/report embed — even when the modal
    // is from a message, .update() needs the isFromMessage() type
    // guard to be available on ModalSubmitInteraction.
    const confirmation = `✓ Dispute filed. A helper has been pinged${proposal === "unsure" ? "" : ` and your proposed result (${proposal}) is on record`}. They'll respond in the dispute thread.`;
    if (interaction.isFromMessage()) {
      await interaction.update({ content: confirmation, components: [] });
    } else {
      await interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
    }
    const pairing = await prisma.pairing.findUnique({
      where: { id: pairingId },
      include: { playerA: true, playerB: true, division: true },
    });
    if (!pairing) return;
    const reporterIsA = pairing.reporterId === pairing.playerAId;
    const reporter = reporterIsA ? pairing.playerA : pairing.playerB;
    const opponent = reporterIsA ? pairing.playerB : pairing.playerA;
    // Build embed for logging/thread purposes only — we don't have a
    // handle on the original announce embed to update from here.
    const _embed = buildReportEmbed({
      status: "DISPUTED",
      reporter,
      opponent,
      divisionName: pairing.division.name,
      result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      reporterIsA,
      pairingId: pairing.id,
    });
    // (update already happened above; just mark _embed as
    // intentionally unused so the lint+tsc don't complain.)
    void _embed;
    spawnDisputeThread(pairing.id, { skipEmbedEdit: true }).catch((err) =>
      console.warn(`[dispute-modal] thread spawn for ${pairingId}:`, err),
    );
  },
};
