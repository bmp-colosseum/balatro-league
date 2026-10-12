import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "../balatro-info.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { buildProblemTicketIssue, isReportProblemAction } from "../report-problem-core.js";
import { reportSet } from "../reporting.js";
import { openSupportTicket } from "./support.js";
import type { ButtonHandler, ModalHandler, SlashCommand } from "./types.js";

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
    .setDescription("Report the result of your 2-game match against an opponent.")
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

    const reporter = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
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

    // reportSet() already recorded it CONFIRMED and enqueued the #results
    // announce + standings recompute — no pending stage, no confirm/dispute
    // window. The announce post itself carries the "Report a problem" button
    // if something's wrong.
    await interaction.editReply(
      `✅ Recorded. It's posted in #results — if anything's wrong, press **Report a problem** on that post.`,
    );
  },
};

// Button handler: customIds are "report:problem:<pairingId>" (current) or
// "report:dispute:<pairingId>" (the pre-existing customId from
// already-posted result announcements before the wording changed) — both
// open the same "Report a problem" modal. There's no live path left that
// creates a fresh Confirm/Dispute pending-report embed (see B20 in
// .claude/knowledge/bot-ux/01-findings.md) — a "report:confirm:" press on
// an old leftover message now just falls through to the broken-button reply.
export const reportButtons: ButtonHandler = {
  prefix: "report:",
  async execute(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const pairingId = parts[2];
    if (!pairingId || !isReportProblemAction(action ?? "")) {
      await interaction.reply({ content: "This button looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Only the two players in this match can flag it — keeps the ticket
    // queue relevant instead of randoms opening tickets about others' matches.
    const subject = await prisma.match.findUnique({
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
        content: "Only the two players in this match can report a problem with it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(buildReportProblemModal(pairingId));
  },
};

// "Report a problem" modal — a single paragraph field. Submitting it opens a
// support ticket the same way /support does (src/commands/support.ts
// openSupportTicket), with the match id and both players folded into the
// ticket text so staff have context without asking.
function buildReportProblemModal(pairingId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`report-problem:${pairingId}`)
    .setTitle("Report a problem");
  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("What's wrong with this result?")
    .setPlaceholder("Explain what's wrong — a helper will follow up in the ticket")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(400)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
  );
  return modal;
}

export const reportProblemModal: ModalHandler = {
  prefix: "report-problem:",
  async execute(interaction: ModalSubmitInteraction) {
    const pairingId = interaction.customId.split(":")[1];
    if (!pairingId) {
      await interaction.reply({ content: "This looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
      return;
    }
    const pairing = await prisma.match.findUnique({
      where: { id: pairingId },
      include: { playerA: true, playerB: true },
    });
    if (!pairing) {
      await interaction.reply({ content: "This match isn't on record anymore.", flags: MessageFlags.Ephemeral });
      return;
    }
    const description = interaction.fields.getTextInputValue("description").trim();
    const issue = buildProblemTicketIssue({
      pairingId: pairing.id,
      playerAName: pairing.playerA.displayName,
      playerBName: pairing.playerB.displayName,
      description,
    });
    await openSupportTicket(interaction, issue);
  },
};
