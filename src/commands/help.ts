// /help (player-facing) + /admin-help (gated to server admins). Split
// so the regular help command doesn't show admin commands a player
// can't run, and the admin help is hidden from the picker entirely
// for non-admins via setDefaultMemberPermissions(Administrator).

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "./types.js";

const PLAYER_COMMANDS = [
  { cmd: "/standings", desc: "Current division standings" },
  { cmd: "/profile [player]", desc: "Match history + ranks (defaults to you)" },
  { cmd: "/schedule", desc: "Matches you still need to play this season" },
  { cmd: "/start-match @opponent", desc: "Guided best-of-2 match: bot walks you through ban/pick for each game" },
  { cmd: "/report @opponent result:2-0|1-1|0-2", desc: "Log a played match (auto-confirmed)" },
  { cmd: "/report-shootout @opponent winner:@p", desc: "Log a 1-game tiebreaker shootout" },
  { cmd: "/challenge @opponent", desc: "Casual match against anyone — not recorded to standings" },
  { cmd: "/helper [reason]", desc: "Call a moderator into the current thread/channel" },
  { cmd: "/random-deck", desc: "Roll a random deck + stake from the league's default pool" },
];

const ADMIN_COMMANDS = [
  { cmd: "/admin record-match @p1 @p2 result", desc: "Manually record a match (e.g. agreed in DMs but never reported)" },
  { cmd: "/admin override-result", desc: "Force-resolve a disputed match" },
  { cmd: "/admin cancel-match session reason", desc: "Force-cancel an in-flight match session" },
  { cmd: "/league bootstrap-server", desc: "One-time setup: creates category, channels, roles, results webhook" },
  { cmd: "/league set-role tier role", desc: "Bind a Discord role to OWNER/ADMIN/HELPER tier" },
  { cmd: "/league unset-role role", desc: "Remove a role's permission binding" },
  { cmd: "/league list-roles", desc: "Show every role currently bound to a tier" },
  { cmd: "/league setup-results-webhook", desc: "Create/recreate the Match Results webhook on a specific channel" },
  { cmd: "/league set-results-webhook url:<url>", desc: "Paste an existing webhook URL for results announces" },
  { cmd: "/league unset-results-webhook", desc: "Stop using a webhook for results announces" },
];

export const help: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the list of player commands."),

  async execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🃏 League commands")
      .setColor(0x5865f2)
      .setDescription(
        PLAYER_COMMANDS.map((c) => `• \`${c.cmd}\` — ${c.desc}`).join("\n"),
      )
      .setFooter({ text: "League admins: run /admin-help for the admin/mod command list." });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const adminHelp: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admin-help")
    .setDescription("Admin + mod command reference.")
    // Hidden from non-admins in the slash picker, matching /admin
    // and /league. Bot doesn't enforce auth on this command itself
    // since it's just printing text — anyone who somehow runs it
    // would just see the same reference page.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString()),

  async execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🔧 Admin + mod commands")
      .setColor(0xf1c40f)
      .setDescription(
        ADMIN_COMMANDS.map((c) => `• \`${c.cmd}\` — ${c.desc}`).join("\n"),
      )
      .setFooter({ text: "Most admin work happens on www.balatroleague.com — these are the Discord-side conveniences." });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
