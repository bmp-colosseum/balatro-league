// Auto-announce confirmed results to a configured Discord channel.
// Caller: anywhere a set transitions to CONFIRMED (web confirm, Discord
// button confirm, admin override, etc.). Sim/auto-play do NOT call this
// — they'd flood the channel.
//
// Two delivery paths, in priority order:
//   1. RESULTS_WEBHOOK_URL — POSTs directly to the channel webhook. Doesn't
//      count against the bot's global 50/sec budget; route bucket is per
//      webhook, not per channel. Preferred for high-volume / burst paths.
//   2. RESULTS_CHANNEL_ID — falls back to bot REST channel.send via the
//      gateway client. Counts against the global budget.
// Configure one or the other; if both are set, webhook wins.

import { ChannelType, EmbedBuilder, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { env } from "./env.js";

export async function announceResult(pairingId: string): Promise<void> {
  if (!env.RESULTS_WEBHOOK_URL && !env.RESULTS_CHANNEL_ID) return;

  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: { include: { season: true } } },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;
  // Skip announcements for INTERNAL/test seasons — they'd flood the real results channel
  if (pairing.division.season.visibility !== "PUBLIC") return;

  let title: string;
  let color: number;
  if (pairing.gamesWonA === 2 && pairing.gamesWonB === 0) {
    title = `🏆 ${pairing.playerA.displayName} swept ${pairing.playerB.displayName}`;
    color = 0x2ecc71;
  } else if (pairing.gamesWonB === 2 && pairing.gamesWonA === 0) {
    title = `🏆 ${pairing.playerB.displayName} swept ${pairing.playerA.displayName}`;
    color = 0x2ecc71;
  } else {
    title = `🤝 ${pairing.playerA.displayName} 1-1 ${pairing.playerB.displayName}`;
    color = 0xf1c40f;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `<@${pairing.playerA.discordId}> **${pairing.gamesWonA}–${pairing.gamesWonB}** <@${pairing.playerB.discordId}>\n` +
        `Division: **${pairing.division.name}**`,
    )
    .setColor(color)
    .setFooter({ text: `Set ${pairing.id}` })
    .setTimestamp(new Date());

  // Prefer webhook — keeps announces out of the bot's global rate limit pool.
  if (env.RESULTS_WEBHOOK_URL) {
    try {
      const res = await fetch(env.RESULTS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed.toJSON()] }),
      });
      if (!res.ok) {
        console.warn(`Webhook announce failed: ${res.status} ${await res.text()}`);
        // Fall through to bot-side fallback below if also configured.
      } else {
        return;
      }
    } catch (err) {
      console.warn("Webhook announce errored:", err);
    }
  }

  // Bot REST fallback.
  if (!env.RESULTS_CHANNEL_ID) return;
  const client = tryGetDiscordClient();
  if (!client) return;
  try {
    const channel = await client.channels.fetch(env.RESULTS_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.warn("Failed to announce result via bot:", err);
  }
}
