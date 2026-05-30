import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { generatePool, getAllowedDecks, getAllowedStakes, seedDefaultsIfEmpty } from "../match-config.js";
import { renderMatch } from "../match-render.js";
import { getOrCreatePlayer } from "../players.js";
import type { SlashCommand } from "./types.js";

export const startMatch: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("start-match")
    .setDescription("Start a guided 2-game set against your opponent (ban/pick + auto-record).")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you're facing").setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    if (opponentUser.id === interaction.user.id) {
      await interaction.reply({ content: "You can't start a match against yourself.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (opponentUser.bot) {
      await interaction.reply({ content: "Opponents must be real players, not bots.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Run this in a regular text channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    const season = await activePublicSeason();
    if (!season) {
      await interaction.editReply("No active season right now.");
      return;
    }

    const me = await getOrCreatePlayer(interaction.user);
    const opp = await getOrCreatePlayer(opponentUser);

    // Both must be in the same division this season
    const sharedMembership = await prisma.divisionMember.findFirst({
      where: {
        playerId: me.id,
        status: "ACTIVE",
        division: { seasonId: season.id },
      },
      include: {
        division: { include: { members: { where: { playerId: opp.id, status: "ACTIVE" } } } },
      },
    });
    if (!sharedMembership || sharedMembership.division.members.length === 0) {
      await interaction.editReply("You and your opponent aren't in the same active division this season.");
      return;
    }

    const division = sharedMembership.division;

    // Check existing CONFIRMED pairing — refuse to start a duplicate match
    const [playerAId, playerBId] = me.id < opp.id ? [me.id, opp.id] : [opp.id, me.id];
    const existing = await prisma.pairing.findUnique({
      where: { divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId } },
    });
    if (existing && existing.status === "CONFIRMED") {
      await interaction.editReply(
        `You've already played ${opponentUser.username} this season (${existing.gamesWonA}-${existing.gamesWonB}). Ask an admin to override if it needs replaying.`,
      );
      return;
    }

    // Refuse if there's already an in-flight session between them
    const inFlight = await prisma.matchSession.findFirst({
      where: {
        divisionId: division.id,
        OR: [
          { playerAId: me.id, playerBId: opp.id },
          { playerAId: opp.id, playerBId: me.id },
        ],
        state: { notIn: ["COMPLETE", "CANCELLED"] },
      },
    });
    if (inFlight) {
      await interaction.editReply(
        `There's already an active match session between you two (${inFlight.id}). Finish it or have an admin cancel it before starting a new one.`,
      );
      return;
    }

    // Make sure deck/stake pool is seeded
    await seedDefaultsIfEmpty();
    const [decks, stakes] = await Promise.all([getAllowedDecks(), getAllowedStakes()]);
    if (decks.length === 0 || stakes.length === 0) {
      await interaction.editReply("Deck or stake pool is empty — ask an admin to configure it.");
      return;
    }

    // Create the session — expiresAt is DB-backed so it survives bot restarts.
    // The accept handler checks it before doing anything else; the boot sweep
    // (match-sweep.ts) also cleans up expired invites we never saw a click on.
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const session = await prisma.matchSession.create({
      data: {
        divisionId: division.id,
        playerAId: me.id,
        playerBId: opp.id,
        state: "WAITING_ACCEPT",
        channelId: interaction.channelId,
        expiresAt,
      },
    });

    const { embeds, components } = renderMatch(session, me, opp);
    const message = await (interaction.channel as TextChannel).send({ embeds, components });

    await interaction.editReply(`Match invite posted: ${message.url}`);
  },
};
