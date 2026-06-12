// /helper — summon a moderator into the current thread/channel.
//
// Pings every Discord role bound to the MOD permission tier in
// RoleBinding. If the command is run inside a private thread, the bot
// also adds the corresponding role members to the thread so they can
// see the conversation without an invite — Discord doesn't expose a
// "ping a role into a private thread" primitive, so we resolve the
// role's members manually and `members.add()` each one.
//
// Public threads + regular channels: the role ping is enough.

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type Role,
  type ThreadChannel,
  type User,
} from "discord.js";
import { prisma } from "../db.js";
import { logDiscordError } from "../log-discord-error.js";
import type { SlashCommand } from "./types.js";

// Shared helper-summon logic. Posts a public ping in the channel and
// adds helper-role members to private threads (since Discord doesn't
// allow role-based private thread membership). Returns null on success
// or an error message string for the caller to surface ephemerally.
export async function summonHelpers(args: {
  guild: Guild;
  channel: GuildTextBasedChannel | null;
  caller: User;
  reason: string;
}): Promise<{ content: string } | { error: string }> {
  const { guild, channel, caller, reason } = args;
  const bindings = await prisma.roleBinding.findMany({ where: { tier: "HELPER" } });
  if (bindings.length === 0) {
    return {
      error:
        "No helper role configured yet. Ask an admin to run `/league set-role tier:HELPER role:@helper-role` first.",
    };
  }
  const pingLines = bindings.map((b) => `<@&${b.discordRoleId}>`).join(" ");
  const isPrivateThread = channel?.type === ChannelType.PrivateThread;
  if (isPrivateThread) {
    const thread = channel as ThreadChannel;
    let added = 0;
    for (const binding of bindings) {
      const role = await guild.roles.fetch(binding.discordRoleId).catch(() => null);
      if (!role) continue;
      for (const member of role.members.values()) {
        if (thread.members.cache.has(member.id)) continue;
        await thread.members.add(member.id).then(
          () => { added++; },
          (err: unknown) => logDiscordError("summon-helpers.thread-add", err, { threadId: thread.id, userId: member.id }),
        );
      }
      void PermissionFlagsBits;
      void (role satisfies Role);
    }
    if (added > 0) console.log(`[helper] added ${added} helper(s) to private thread ${thread.id}`);
  }
  const callerMention = `<@${caller.id}>`;
  const where = isPrivateThread ? "this thread" : "this channel";
  const reasonLine = reason ? `\n> ${reason}` : "";
  return { content: `🆘 ${pingLines} — ${callerMention} requested help in ${where}.${reasonLine}` };
}

export const helper: SlashCommand = {
  // Posts a public ping, so confine to the bot-commands channel(s) — but the
  // scope check also allows THREADS spawned under an allowed channel (match /
  // dispute threads), which is where /helper is normally used.
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("helper")
    .setDescription("Call a moderator into this thread/channel for assistance.")
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Optional context for the helper")
        .setRequired(false)
        .setMaxLength(500),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Run this in a server channel, not DMs.", flags: MessageFlags.Ephemeral });
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() ?? "";
    const channel = interaction.channel as GuildTextBasedChannel | null;
    const result = await summonHelpers({
      guild: interaction.guild,
      channel,
      caller: interaction.user,
      reason,
    });
    if ("error" in result) {
      await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }
    // The ping itself stays public — helpers need to see it, and the
    // whole point of /helper is to summon attention. The runner gets the
    // public message as their reply since they're already in-thread.
    await interaction.reply({ content: result.content });
  },
};
