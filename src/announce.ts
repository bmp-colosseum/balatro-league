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
  const pairing = await prisma.match.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: { include: { season: true } } },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;

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

  // Forfeit/DQ wins are flagged publicly ("by DQ") but the reason stays
  // admin-only — never surface pairing.forfeitReason here.
  const dqSuffix = pairing.forfeit ? " — by DQ" : "";
  let title: string;
  let color: number;
  if (pairing.gamesWonA === 2 && pairing.gamesWonB === 0) {
    title = `🏆 ${pairing.playerA.displayName} beats ${pairing.playerB.displayName}${dqSuffix}`;
    color = 0x2ecc71;
  } else if (pairing.gamesWonB === 2 && pairing.gamesWonA === 0) {
    title = `🏆 ${pairing.playerB.displayName} beats ${pairing.playerA.displayName}${dqSuffix}`;
    color = 0x2ecc71;
  } else {
    title = `🤝 ${pairing.playerA.displayName} draws ${pairing.playerB.displayName}`;
    color = 0xf1c40f;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `<@${pairing.playerA.discordId}> **${pairing.gamesWonA}–${pairing.gamesWonB}** <@${pairing.playerB.discordId}>\n` +
        `Division: **${pairing.division.name}**` +
        (pairing.forfeit ? `\n_Win by forfeit / DQ._` : ""),
    )
    .setColor(color)
    .setFooter({ text: `Match ${pairing.id}` })
    .setTimestamp(new Date());
  if (pairing.reportedDeck || pairing.reportedStake) {
    embed.addFields({
      name: "🎴 Played",
      value: [pairing.reportedDeck, pairing.reportedStake].filter(Boolean).join(" / "),
      inline: false,
    });
  }

  // Dispute button — visible inline so a player who sees their result
  // and disagrees can flag it without leaving the channel. Routes to
  // the existing report:dispute handler in src/commands/report.ts which
  // already accepts CONFIRMED pairings (kicks off the dispute flow).
  const components = [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 4, // DANGER (red)
          label: "Dispute this result",
          custom_id: `report:dispute:${pairing.id}`,
        },
      ],
    },
  ];

  // Bot REST is the preferred path because it can attach interactive
  // components (the Dispute button). User-created webhook URLs CAN'T
  // — only application-owned webhooks support components, and that's
  // more setup than just using the bot identity directly.
  if (channelId) {
    try {
      const body: RESTPostAPIChannelMessageJSONBody = { embeds: [embed.toJSON()], components };
      await rest().post(Routes.channelMessages(channelId), { body });
      return;
    } catch (err) {
      console.warn("[announceResult] REST post failed:", err);
      // Fall through to webhook if configured — better to post without
      // a button than not post at all.
    }
  }

  // Webhook fallback — posts the embed without the dispute button
  // (webhooks don't carry interactive components reliably). Useful
  // when no channel id is configured at all.
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed.toJSON()] }),
      });
      if (!res.ok) {
        console.warn(`[announceResult] webhook failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.warn("[announceResult] webhook errored:", err);
    }
  }
}

// Casual /challenge result feed. Casual matches write no Match row (no division,
// not standings-affecting), so this takes the data inline instead of a pairing
// id. Delivery + config precedence mirror announceResult, but with a final
// fallback to the #challenges channel so it posts with zero extra setup. No
// dispute button — casual results aren't recorded, so there's nothing to flag.
export async function announceChallengeResult(opts: {
  sessionId: string;
  playerA: { discordId: string; displayName: string };
  playerB: { discordId: string; displayName: string };
  winsA: number;
  winsB: number;
  combos: Array<{ deck: string | null; stake: string | null }>;
}): Promise<void> {
  const webhookUrl =
    (await getConfig(LeagueConfigKey.ChallengeResultsWebhookUrl)) || undefined;
  const channelId =
    (await getConfig(LeagueConfigKey.ChallengeResultsChannelId)) ||
    (await getConfig(LeagueConfigKey.ChallengesChannelId)) ||
    undefined;
  if (!webhookUrl && !channelId) return;

  const { playerA, playerB, winsA, winsB } = opts;
  let title: string;
  let color: number;
  if (winsA > winsB) {
    title = `🎴 ${playerA.displayName} beats ${playerB.displayName}`;
    color = 0x9b59b6;
  } else if (winsB > winsA) {
    title = `🎴 ${playerB.displayName} beats ${playerA.displayName}`;
    color = 0x9b59b6;
  } else {
    title = `🎴 ${playerA.displayName} draws ${playerB.displayName}`;
    color = 0x95a5a6;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `<@${playerA.discordId}> **${winsA}–${winsB}** <@${playerB.discordId}>\n_Casual challenge — not counted toward standings._`,
    )
    .setColor(color)
    .setFooter({ text: "Challenge" })
    .setTimestamp(new Date());
  const played = opts.combos
    .map((c, i) => {
      const v = [c.deck, c.stake].filter(Boolean).join(" / ");
      return v ? `Game ${i + 1}: ${v}` : null;
    })
    .filter(Boolean) as string[];
  if (played.length > 0) {
    embed.addFields({ name: "🃏 Decks played", value: played.join("\n"), inline: false });
  }

  if (channelId) {
    try {
      const body: RESTPostAPIChannelMessageJSONBody = { embeds: [embed.toJSON()] };
      await rest().post(Routes.channelMessages(channelId), { body });
      return;
    } catch (err) {
      console.warn("[announceChallengeResult] REST post failed:", err);
    }
  }
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed.toJSON()] }),
      });
      if (!res.ok) {
        console.warn(`[announceChallengeResult] webhook failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.warn("[announceChallengeResult] webhook errored:", err);
    }
  }
}
