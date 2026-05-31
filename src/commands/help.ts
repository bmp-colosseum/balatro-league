// /help — ephemeral list of every league slash command. Cheap insurance
// against members forgetting what's available.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "./types.js";

const PLAYER_COMMANDS = [
  { cmd: "/standings", desc: "Current division standings" },
  { cmd: "/profile [player]", desc: "Match history + ranks (defaults to you)" },
  { cmd: "/schedule", desc: "Sets you still need to play this season" },
  { cmd: "/start-match @opponent", desc: "Guided best-of-2 set: bot picks the deck/stake via ban/pick" },
  { cmd: "/report @opponent result:2-0|1-1|0-2", desc: "Log a played set (auto-confirmed)" },
];

const ADMIN_COMMANDS = [
  { cmd: "/admin record-set @p1 @p2 result", desc: "Manually record a set (e.g. agreed in DMs but never reported)" },
  { cmd: "/admin override-result set-id result reason", desc: "Force-resolve a disputed set" },
  { cmd: "/league bootstrap-server", desc: "One-time setup: creates category, channels, and roles" },
  { cmd: "/league set-role tier role", desc: "Bind a Discord role to ADMIN/MOD/OWNER tier" },
  { cmd: "/league unset-role role", desc: "Remove a role's permission binding" },
  { cmd: "/league list-roles", desc: "Show every role currently bound to a tier" },
  { cmd: "/league setup-results-webhook", desc: "Auto-create a webhook for results announces (needs Manage Webhooks)" },
  { cmd: "/league set-results-webhook url:<url>", desc: "Paste an existing webhook URL for results announces" },
  { cmd: "/league unset-results-webhook", desc: "Stop using a webhook for results announces" },
];

export const help: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show every league command and what it does."),

  async execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🃏 League commands")
      .setColor(0x5865f2)
      .addFields(
        {
          name: "Player",
          value: PLAYER_COMMANDS.map((c) => `• \`${c.cmd}\` — ${c.desc}`).join("\n"),
          inline: false,
        },
        {
          name: "Admin / mod",
          value: ADMIN_COMMANDS.map((c) => `• \`${c.cmd}\` — ${c.desc}`).join("\n"),
          inline: false,
        },
      )
      .setFooter({ text: "Most admin work happens on www.balatroleague.com — these commands are the Discord-side conveniences." });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
