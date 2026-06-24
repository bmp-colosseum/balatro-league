// /challenge — same ban/pick flow as /start-match but NOT a league match.
// No division or season required, no Pairing written, no announce. Best-of
// is configurable (1, 2, or 3).

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { actorFromInteractionUser, recordAudit } from "../audit.js";
import { resolveChallengesChannelId } from "../challenges-channel.js";
import { prisma } from "../db.js";
import { getLeagueSettings } from "../league-settings.js";
import { renderMatch } from "../match-render.js";
import { postModerationNotice } from "../mod-log.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import type { SlashCommand } from "./types.js";

const BO_CHOICES = [
  { name: "Best of 1", value: 1 },
  { name: "Best of 2", value: 2 },
  { name: "Best of 3", value: 3 },
] as const;

export const challenge: SlashCommand = {
  // No channelScope — the reply is ephemeral and the challenge thread
  // spawns under the dedicated #challenges channel (or current channel
  // as fallback), so it's safe to run from anywhere.
  data: new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Casual best-of-N match against another player (not recorded to the league).")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you're challenging").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("best-of")
        .setDescription("Number of games (default 1)")
        .setRequired(false)
        .addChoices(...BO_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    const bestOf = (interaction.options.getInteger("best-of") ?? 1) as 1 | 2 | 3;

    if (opponentUser.id === interaction.user.id) {
      await interaction.reply({ content: "Can't challenge yourself.", flags: MessageFlags.Ephemeral });
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

    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
    const opp = await getOrCreatePlayer(opponentUser);

    // Refuse if there's an in-flight session between them (league OR casual)
    const inFlight = await prisma.matchSession.findFirst({
      where: {
        OR: [
          { playerAId: me.id, playerBId: opp.id },
          { playerAId: opp.id, playerBId: me.id },
        ],
        state: { notIn: ["COMPLETE", "CANCELLED"] },
      },
    });
    if (inFlight) {
      await interaction.editReply(
        `There's already an active match between you two (${inFlight.id}). Finish it or have an admin cancel it before starting another.`,
      );
      return;
    }

    // Casual session — no division, no season.
    const settings = await getLeagueSettings();
    const expiresAt = new Date(Date.now() + settings.matchInviteExpiryMinutes * 60 * 1000);
    const session = await prisma.matchSession.create({
      data: {
        playerAId: me.id,
        playerBId: opp.id,
        state: "WAITING_ACCEPT",
        channelId: interaction.channelId,
        isCasual: true,
        bestOf,
        expiresAt,
      },
    });

    // Starting any match drops both players from the league queue — keeps the
    // "free right now" list honest if you challenge someone while queued.
    await prisma.queueEntry.deleteMany({ where: { playerId: { in: [me.id, opp.id] } } }).catch(() => {});

    // Create a private thread for the invite itself so it doesn't blow
    // up #bot-commands with one public message per challenge. Parent is
    // the dedicated #challenges channel when configured, else the channel
    // /challenge was run from (bot-commands by default per channelScope).
    // Opponent is added as a thread member → they get a Discord
    // notification + the thread appears in their sidebar. Same thread
    // is reused for the match itself after Accept.
    const challengesId = await resolveChallengesChannelId();
    let parent: TextChannel | null = null;
    if (challengesId) {
      try {
        const fetched = await interaction.client.channels.fetch(challengesId);
        if (fetched && fetched.type === ChannelType.GuildText) {
          parent = fetched as TextChannel;
        }
      } catch {
        // Fall through to interaction.channel.
      }
    }
    if (!parent && interaction.channel?.type === ChannelType.GuildText) {
      parent = interaction.channel as TextChannel;
    }
    if (!parent) {
      await interaction.editReply("Couldn't find a channel to spawn the challenge thread.");
      return;
    }

    let threadId: string | null = null;
    try {
      const suffix = session.id.slice(-6);
      const thread = await parent.threads.create({
        name: `Challenge: ${me.displayName} vs ${opp.displayName} (${suffix})`,
        type: ChannelType.PrivateThread,
        // 60 min is the minimum auto-archive for private threads. Session
        // expiry runs separately (5 min default) — match-sweep cancels
        // the session, the thread itself sticks around until Discord
        // auto-archives it.
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        invitable: false,
      });
      await thread.members.add(me.discordId).catch(() => {});
      await thread.members.add(opp.discordId).catch(() => {});
      // First thing in the thread: the moderation-recording notice (pinned).
      await postModerationNotice(thread);
      threadId = thread.id;
    } catch (err) {
      console.warn("[challenge] failed to create private thread:", err);
      await interaction.editReply("Couldn't create the challenge thread — an admin may need to grant the Create Private Threads permission.");
      return;
    }

    // Persist the thread id so handleAccept reuses this thread instead
    // of creating a second one when the opponent accepts.
    const updatedSession = await prisma.matchSession.update({
      where: { id: session.id },
      data: { threadId },
    });

    const { embeds, components } = renderMatch(updatedSession, me, opp);
    try {
      const thread = await interaction.client.channels.fetch(threadId);
      if (thread && thread.type === ChannelType.PrivateThread) {
        const sent = await thread.send({
          content: `<@${opp.discordId}> — <@${me.discordId}> wants to play. Invite expires in ${settings.matchInviteExpiryMinutes} min.`,
          embeds,
          components,
        });
        // Persist for ephemeral ban-menu cross-interaction edits.
        await prisma.matchSession.update({
          where: { id: session.id },
          data: { matchMessageId: sent.id },
        }).catch((err) => console.warn(`[challenge] persist messageId failed:`, err));
      }
    } catch (err) {
      console.warn("[challenge] failed to post invite into thread:", err);
    }

    recordAudit({
      actor: actorFromInteractionUser(interaction.user),
      action: "match.create",
      targetType: "MatchSession",
      targetId: session.id,
      summary: `Challenged ${opp.displayName} (casual best-of-${bestOf})`,
      metadata: { isCasual: true, bestOf, opponentDiscordId: opponentUser.id, threadId },
    });

    await interaction.editReply(
      `Challenge sent — opened a private thread with ${opponentUser}. Check your sidebar; expires in ${settings.matchInviteExpiryMinutes} min if not accepted.`,
    );
  },
};
