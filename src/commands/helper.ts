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
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Role,
  type ThreadChannel,
} from "discord.js";
import { prisma } from "../db.js";
import { logDiscordError } from "../log-discord-error.js";
import type { SlashCommand } from "./types.js";

export const helper: SlashCommand = {
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
      await interaction.reply({ content: "Run this in a server channel, not DMs.", ephemeral: true });
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() ?? "";

    const bindings = await prisma.roleBinding.findMany({ where: { tier: "HELPER" } });
    if (bindings.length === 0) {
      await interaction.reply({
        content:
          "No helper role configured yet. Ask an admin to run `/league set-role tier:HELPER role:@helper-role` first.",
        ephemeral: true,
      });
      return;
    }

    const pingLines = bindings.map((b) => `<@&${b.discordRoleId}>`).join(" ");
    const channel = interaction.channel;
    const isPrivateThread = channel?.type === ChannelType.PrivateThread;

    // For private threads, add every member of every bound MOD role
    // before the ping so they can actually see the message. Threads
    // don't accept a role-add, only individual user-adds — Discord
    // never built role-to-thread membership.
    if (isPrivateThread) {
      const thread = channel as ThreadChannel;
      let added = 0;
      for (const binding of bindings) {
        const role = await interaction.guild.roles.fetch(binding.discordRoleId).catch(() => null);
        if (!role) continue;
        for (const member of role.members.values()) {
          if (thread.members.cache.has(member.id)) continue;
          await thread.members.add(member.id).then(
            () => { added++; },
            (err: unknown) => logDiscordError("helper.thread-add", err, { threadId: thread.id, userId: member.id }),
          );
        }
        void PermissionFlagsBits;
        void (role satisfies Role);
      }
      if (added > 0) {
        console.log(`[helper] added ${added} moderator(s) to private thread ${thread.id}`);
      }
    }

    const callerMention = `<@${interaction.user.id}>`;
    const where = isPrivateThread ? "this thread" : "this channel";
    const reasonLine = reason ? `\n> ${reason}` : "";
    const content = `🆘 ${pingLines} — ${callerMention} requested help in ${where}.${reasonLine}`;

    await interaction.reply({ content });
  },
};
