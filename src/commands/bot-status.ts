// /league-bot-status -- admin diagnostic that renders the cached BotHealth
// snapshot (../bot-health.ts). Read-only: it never re-runs a check, so this
// command answers instantly no matter how slow Discord/DB currently are.
// The embed itself is built by ../bot-status-content.ts (buildHealthEmbed),
// shared with the self-updating #bot-status channel message
// (channel-refresh.ts's refreshBotStatusMessage) so the two surfaces render
// identically and can never drift apart.

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getCachedHealth } from "../bot-health.js";
import { buildHealthEmbed } from "../bot-status-content.js";
import type { SlashCommand } from "./types.js";

export const botStatus: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("league-bot-status")
    .setDescription("Bot health snapshot -- Discord, database, and queue status (admin diagnostic).")
    // Diagnostic tool, hidden from the player-facing command picker like
    // /admin and /league -- the bot still just reads a cache, no elevated
    // action, but there's no player-facing reason to see this.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString()),

  async execute(interaction: ChatInputCommandInteraction) {
    const health = getCachedHealth();
    if (!health) {
      await interaction.reply({
        content: "No health data cached yet -- the bot just started. Try again in about a minute.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({ embeds: [buildHealthEmbed(health)], flags: MessageFlags.Ephemeral });
  },
};
