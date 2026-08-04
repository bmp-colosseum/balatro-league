// /league-bot-status -- admin diagnostic that renders the cached BotHealth
// snapshot (../bot-health.ts). Read-only: it never re-runs a check, so this
// command answers instantly no matter how slow Discord/DB currently are.

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getCachedHealth, type BotHealth, type HealthLevel } from "../bot-health.js";
import type { SlashCommand } from "./types.js";

const LEVEL_COLOR: Record<HealthLevel, number> = {
  ok: 0x57f287,
  degraded: 0xfee75c,
  down: 0xed4245,
};

const LEVEL_EMOJI: Record<HealthLevel, string> = {
  ok: "\u{1F7E2}",
  degraded: "\u{1F7E1}",
  down: "\u{1F534}",
};

function fmtMs(ms: number | null): string {
  return ms === null ? "insufficient data" : `${Math.round(ms)}ms`;
}

function fmtRate(rate: number | null): string {
  return rate === null ? "insufficient data" : `${(rate * 100).toFixed(1)}%`;
}

// Exported for testing the rendering shape without spinning up a real
// interaction -- pure given a BotHealth snapshot.
export function renderHealthEmbed(health: BotHealth): EmbedBuilder {
  const checkedAtUnix = Math.floor(health.checkedAt.getTime() / 1000);
  return new EmbedBuilder()
    .setTitle(`${LEVEL_EMOJI[health.level]} Bot health -- ${health.level.toUpperCase()}`)
    .setColor(LEVEL_COLOR[health.level])
    .setDescription(`Last checked <t:${checkedAtUnix}:R>`)
    .addFields(
      {
        name: "Discord",
        value: [
          `Gateway ping: ${fmtMs(health.discord.gatewayPingMs)}`,
          `REST p95: ${fmtMs(health.discord.restP95Ms)}`,
          `REST error rate: ${fmtRate(health.discord.restErrorRate)}`,
        ].join("\n"),
      },
      {
        name: "Database",
        value: `${health.db.ok ? LEVEL_EMOJI.ok + " reachable" : LEVEL_EMOJI.down + " unreachable"} -- latency ${fmtMs(health.db.latencyMs)}`,
      },
      {
        name: "Queue",
        value: health.queue.stalled.length
          ? `${LEVEL_EMOJI.degraded} stalled: ${health.queue.stalled.join(", ")}`
          : `${LEVEL_EMOJI.ok} ok`,
      },
      {
        name: "Notes",
        value: health.notes.map((n) => `- ${n}`).join("\n"),
      },
    );
}

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
    await interaction.reply({ embeds: [renderHealthEmbed(health)], flags: MessageFlags.Ephemeral });
  },
};
