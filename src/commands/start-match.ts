import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { actorFromInteractionUser } from "../audit.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { createLeagueMatchInvite } from "../league-match-invite.js";
import type { SlashCommand } from "./types.js";

const MODE_CHOICES = [
  { name: "League match (2 games, default)", value: "league" },
  { name: "Shootout (1 game — for when you're tied with the opponent)", value: "shootout" },
] as const;

export const startMatch: SlashCommand = {
  // Runs ANYWHERE: the reply is ephemeral and the match lives in a private
  // thread under #league-matches, so nothing public lands in the channel it's
  // run from. The division comes from the players' membership, not the channel.
  channelScope: "any",
  data: new SlashCommandBuilder()
    .setName("start-match")
    .setDescription("Start a guided match against your opponent (ban/pick + auto-record).")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you're facing").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("League match (2 games, default) or shootout tiebreaker (1 game)")
        .setRequired(false)
        .addChoices(...MODE_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    const mode = interaction.options.getString("mode") ?? "league";
    const isShootout = mode === "shootout";
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const season = await activePublicSeason();
    if (!season) {
      await interaction.editReply("No active season right now.");
      return;
    }

    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
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

    // All the match-validity checks + session/thread/invite creation live in the
    // shared helper, so /start-match and the league queue create matches the
    // exact same way.
    const result = await createLeagueMatchInvite({
      client: interaction.client,
      season: { id: season.id },
      division: { id: division.id },
      me,
      opp,
      isShootout,
      channelId: interaction.channelId,
      source: "command",
      actor: actorFromInteractionUser(interaction.user),
    });
    if (!result.ok) {
      await interaction.editReply(result.error ?? "Couldn't start the match.");
      return;
    }

    await interaction.editReply(
      `Match invite sent — opened a private thread with ${opponentUser}. Check your sidebar; expires in ${result.expiryMinutes} min if not accepted.` +
        (result.inviteUrl ? `\n${result.inviteUrl}` : ""),
    );
  },
};
