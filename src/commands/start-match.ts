import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { actorFromInteractionUser, recordAudit } from "../audit.js";
import { prisma } from "../db.js";
import { getLeagueSettingsForSeason } from "../league-settings.js";
import { bootstrapPresetsAndPointers, presetForSeason } from "../match-config.js";
import { renderMatch } from "../match-render.js";
import { getOrCreatePlayer } from "../players.js";
import type { SlashCommand } from "./types.js";

const MODE_CHOICES = [
  { name: "League match (best of 2, default)", value: "league" },
  { name: "Shootout (1 game — for when you're tied with the opponent)", value: "shootout" },
] as const;

export const startMatch: SlashCommand = {
  channelScope: "division-only",
  data: new SlashCommandBuilder()
    .setName("start-match")
    .setDescription("Start a guided match against your opponent (ban/pick + auto-record).")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you're facing").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("League match (BO2 default) or shootout tiebreaker (BO1)")
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

    // For league mode, refuse a duplicate match. For shootout mode the
    // regular-season Pairing SHOULD already exist (the 1-1 draw that
    // triggered the need for a shootout in the first place) — so we
    // allow the shootout flow to proceed even with an existing Pairing.
    const [playerAId, playerBId] = me.id < opp.id ? [me.id, opp.id] : [opp.id, me.id];
    const existing = await prisma.match.findUnique({
      where: {
        divisionId_playerAId_playerBId_format: {
          divisionId: division.id,
          playerAId,
          playerBId,
          format: "LEAGUE_BO2",
        },
      },
    });
    if (!isShootout && existing && existing.status === "CONFIRMED") {
      await interaction.editReply(
        `You've already played ${opponentUser.username} this season (${existing.gamesWonA}-${existing.gamesWonB}). ` +
          `If you're playing a tiebreaker, use \`mode: Shootout\` instead.`,
      );
      return;
    }
    // Shootout mode also wants to avoid a duplicate Shootout row — bail
    // if one already exists.
    if (isShootout) {
      const existingShootout = await prisma.match.findUnique({
        where: {
          divisionId_playerAId_playerBId_format: {
            divisionId: division.id,
            playerAId,
            playerBId,
            format: "SHOOTOUT_BO1",
          },
        },
      });
      if (existingShootout) {
        await interaction.editReply(
          `A shootout result is already recorded for this pair. Ask a Helper to revise via \`/admin record-shootout\` if it's wrong.`,
        );
        return;
      }
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

    // Resolve the season's match-config preset (or bootstrap a stock
    // preset + config pointers on first run).
    await bootstrapPresetsAndPointers();
    const preset = await presetForSeason(season.id);
    if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
      await interaction.editReply(
        "This season's match config preset is empty or missing — ask an admin to pick a preset on `/admin/deck-bans` and (optionally) assign one to this season.",
      );
      return;
    }

    // Create the session — expiresAt is DB-backed so it survives bot restarts.
    // The accept handler checks it before doing anything else; the boot sweep
    // (match-sweep.ts) also cleans up expired invites we never saw a click on.
    const settings = await getLeagueSettingsForSeason(season.id);
    const expiresAt = new Date(Date.now() + settings.matchInviteExpiryMinutes * 60 * 1000);
    const session = await prisma.matchSession.create({
      data: {
        divisionId: division.id,
        playerAId: me.id,
        playerBId: opp.id,
        state: "WAITING_ACCEPT",
        channelId: interaction.channelId,
        expiresAt,
        // Shootout = 1-game tiebreaker. Same ban/pick flow but one
        // game decides it, and finalizeMatch writes a Shootout row
        // instead of a Pairing.
        isShootout,
        bestOf: isShootout ? 1 : 2,
      },
    });

    // Create a private thread under the division channel (like /challenge)
    // and put the invite there, instead of posting it in the league channel.
    // Persisting threadId up front means handleAccept reuses this thread
    // (no relocation, no league-channel message at all).
    let threadId: string | null = null;
    try {
      const parent = interaction.channel as TextChannel;
      const suffix = session.id.slice(-6);
      const thread = await parent.threads.create({
        name: `Match · ${me.displayName} vs ${opp.displayName} · ${suffix}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        invitable: false,
      });
      await thread.members.add(me.discordId).catch(() => {});
      await thread.members.add(opp.discordId).catch(() => {});
      threadId = thread.id;
    } catch (err) {
      console.warn("[start-match] failed to create private thread:", err);
      await interaction.editReply("Couldn't create the match thread — check the bot has Create Private Threads permission.");
      return;
    }

    const updatedSession = await prisma.matchSession.update({
      where: { id: session.id },
      data: { threadId },
    });

    const { embeds, components, content } = renderMatch(updatedSession, me, opp);
    let inviteUrl: string | null = null;
    try {
      const thread = await interaction.client.channels.fetch(threadId);
      if (thread && thread.type === ChannelType.PrivateThread) {
        const sent = await thread.send({
          content:
            content ||
            `<@${opp.discordId}> — <@${me.discordId}> wants to play. Accept within ${settings.matchInviteExpiryMinutes} min.`,
          embeds,
          components,
        });
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { matchMessageId: sent.id },
        }).catch((err) => console.warn(`[start-match] persist messageId failed:`, err));
        inviteUrl = sent.url;
      }
    } catch (err) {
      console.warn("[start-match] failed to post invite into thread:", err);
    }

    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "match.create",
      targetType: "MatchSession",
      targetId: session.id,
      summary: `Invited ${opp.displayName} to ${isShootout ? "a shootout" : "a league match"}`,
      metadata: {
        isShootout,
        divisionId: division.id,
        seasonId: season.id,
        opponentDiscordId: opponentUser.id,
        threadId,
      },
    });

    await interaction.editReply(
      `Match invite sent — opened a private thread with ${opponentUser}. Check your sidebar; expires in ${settings.matchInviteExpiryMinutes} min if not accepted.` +
        (inviteUrl ? `\n${inviteUrl}` : ""),
    );
  },
};
