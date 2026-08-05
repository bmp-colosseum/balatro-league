// /league-bot-status -- renders the cached BotHealth snapshot (../bot-health.ts).
// Read-only: it never re-runs a check, so this command answers instantly no
// matter how slow Discord/DB currently are. Dual audience, same as the
// #bot-status channel message: admins/owner (per permissions.ts's hasTier)
// get the full technical embed (buildHealthEmbed); everyone else gets the
// plain-language, number-free public embed (buildPublicHealthEmbed) -- both
// built by ../bot-status-content.ts so this command and the channel message
// can never render two different stories about the same snapshot.

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getCachedHealth } from "../bot-health.js";
import { buildHealthEmbed, buildPublicHealthEmbed } from "../bot-status-content.js";
import { hasTier } from "../permissions.js";
import type { SlashCommand } from "./types.js";

export const botStatus: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("league-bot-status")
    .setDescription("Bot health snapshot -- is everything running normally right now?"),

  async execute(interaction: ChatInputCommandInteraction) {
    const health = getCachedHealth();
    if (!health) {
      await interaction.reply({
        content: "No health data cached yet -- the bot just started. Try again in about a minute.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const member =
      interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
    const isAdminOrOwner = await hasTier(member, interaction.user.id, "ADMIN");
    const embed = isAdminOrOwner ? buildHealthEmbed(health) : buildPublicHealthEmbed(health);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
