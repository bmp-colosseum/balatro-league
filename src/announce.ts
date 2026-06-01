// Auto-announce confirmed results to a configured Discord channel.
// Caller: anywhere a set transitions to CONFIRMED (web confirm, Discord
// button confirm, admin override, etc.). Sim/auto-play do NOT call this
// — they'd flood the channel.
//
// Two delivery paths, in priority order:
//   1. Webhook URL — POSTs directly to the channel webhook. Doesn't
//      count against the bot's global 50/sec budget; route bucket is per
//      webhook, not per channel. Preferred for high-volume / burst paths.
//   2. Channel ID — uses @discordjs/rest with DISCORD_TOKEN. Works in
//      ANY context (bot, web, standalone script) since it doesn't
//      require the gateway client to be running. Counts against the
//      bot's global rate limit budget but @discordjs/rest queues
//      politely so a burst won't drop messages.
//
// Config precedence for each, season → global → env, so individual seasons
// can post to their own channel without touching the global config:
//   webhook: season.resultsWebhookUrl → LeagueConfig.ResultsWebhookUrl → env.RESULTS_WEBHOOK_URL
//   channel: season.resultsChannelId  → LeagueConfig.ResultsChannelId → env.RESULTS_CHANNEL_ID

import { REST } from "@discordjs/rest";
import { Routes, type RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { EmbedBuilder } from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";

let cachedRest: REST | null = null;
function rest(): REST {
  if (!cachedRest) cachedRest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  return cachedRest;
}

export async function announceResult(pairingId: string): Promise<void> {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: { include: { season: true } } },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;
  // Skip announcements for INTERNAL/test seasons — they'd flood the real results channel
  if (pairing.division.season.visibility !== "PUBLIC") return;

  const season = pairing.division.season;
  const webhookUrl =
    season.resultsWebhookUrl ||
    (await getConfig(LeagueConfigKey.ResultsWebhookUrl)) ||
    env.RESULTS_WEBHOOK_URL;
  const channelId =
    season.resultsChannelId ||
    (await getConfig(LeagueConfigKey.ResultsChannelId)) ||
    env.RESULTS_CHANNEL_ID;
  if (!webhookUrl && !channelId) return;

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
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
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

  // REST fallback — works without a live gateway client, so this also
  // fires correctly from standalone scripts (finish:season --announce
  // etc.) where the bot's discord.js Client isn't initialized.
  if (!channelId) return;
  try {
    const body: RESTPostAPIChannelMessageJSONBody = { embeds: [embed.toJSON()] };
    await rest().post(Routes.channelMessages(channelId), { body });
  } catch (err) {
    console.warn("[announceResult] REST post failed:", err);
  }
}
