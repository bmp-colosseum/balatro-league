// Auto-announce confirmed pairings to Discord from the web side.
// Mirrors src/announce.ts so a result posted via the dashboard ends
// up in the same channel as one reported through the bot.
//
// Resolution chain (first non-empty wins):
//   webhook: season.resultsWebhookUrl
//          → LeagueConfig.ResultsWebhookUrl
//          → env.RESULTS_WEBHOOK_URL
//   channelId: season.resultsChannelId
//          → env.RESULTS_CHANNEL_ID
//
// Tries webhook first (cheaper, no bot rate limit), falls back to a
// bot-REST channel post via web/lib/discord's postChannelMessage if
// a channel id resolves. Skips INTERNAL/test seasons so they don't
// flood the real results channel.

import { prisma } from "@/lib/prisma";
import { postChannelMessage } from "@/lib/discord";

const LEAGUE_CONFIG_KEY_RESULTS_WEBHOOK = "results_webhook_url";

export async function announceResult(pairingId: string): Promise<void> {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: { include: { season: true } } },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;
  if (pairing.division.season.visibility !== "PUBLIC") return;

  const season = pairing.division.season;
  const globalWebhookRow = await prisma.leagueConfig.findUnique({
    where: { key: LEAGUE_CONFIG_KEY_RESULTS_WEBHOOK },
  });
  const webhookUrl =
    season.resultsWebhookUrl ||
    globalWebhookRow?.value ||
    process.env.RESULTS_WEBHOOK_URL ||
    null;
  const channelId = season.resultsChannelId || process.env.RESULTS_CHANNEL_ID || null;
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
  const embed = {
    title,
    description:
      `<@${pairing.playerA.discordId}> **${pairing.gamesWonA}–${pairing.gamesWonB}** <@${pairing.playerB.discordId}>\n` +
      `Division: **${pairing.division.name}**`,
    color,
    footer: { text: `Set ${pairing.id}` },
    timestamp: new Date().toISOString(),
  };

  // Webhook first — keeps announces out of the bot's global rate-limit pool.
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.ok) return;
      console.warn(`[announceResult] webhook failed: ${res.status} ${await res.text()}`);
      // fall through to channel REST
    } catch (err) {
      console.warn("[announceResult] webhook errored:", err);
    }
  }

  // Bot-REST channel fallback. Web has DISCORD_TOKEN via the same env,
  // so postChannelMessage can post to any channel the bot can see.
  if (!channelId) return;
  try {
    await postChannelMessage(channelId, { embeds: [embed] });
  } catch (err) {
    console.warn("[announceResult] channel REST errored:", err);
  }
}
