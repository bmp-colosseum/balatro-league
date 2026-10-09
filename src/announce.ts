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
import { MessageFlags, Routes, type RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { deckEmoji, stakeEmoji } from "./balatro-emojis.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { formatSeasonLabel } from "./format-season.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { attachRestTiming } from "./rate-limit-logger.js";
import { buildConfirmedResultBlocks, type GameLineInput } from "./result-message-core.js";
import { sanitizeName } from "./sanitize.js";
import { tierAccentColor } from "./tier-colors.js";
import { webUrl } from "./web-url.js";

let cachedRest: REST | null = null;
function rest(): REST {
  if (!cachedRest) {
    cachedRest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
    // Standalone instance bypasses client.rest -- time it too so
    // bot_discord_rest_* covers announce/webhook traffic.
    attachRestTiming(cachedRest);
  }
  return cachedRest;
}

export async function announceResult(pairingId: string): Promise<void> {
  const pairing = await prisma.match.findUnique({
    where: { id: pairingId },
    include: {
      playerA: true,
      playerB: true,
      division: { include: { season: true, tier: true } },
      // Per-game deck/stake lives on Game rows (the guided /start-match flow
      // writes them via writeMatchGames). The legacy Match.reportedDeck/
      // reportedStake columns are only populated by the old /report path and
      // admin manual entry, so on a normally-played league match they are
      // null -- which is why the "Played" field silently vanished.
      games: { orderBy: { num: "asc" } },
    },
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

  // Per-game breakdown: what was played and who took it. Prefer the real Game
  // rows; fall back to the legacy reported* columns for matches recorded through
  // the old /report path or admin manual entry (which have no Game deck/stake).
  const games: GameLineInput[] = pairing.games.map((g) => ({
    num: g.num,
    deck: g.deck,
    stake: g.stake,
    deckEmoji: g.deck ? deckEmoji(g.deck) : null,
    stakeEmoji: g.stake ? stakeEmoji(g.stake) : null,
    winnerName:
      g.winnerId === pairing.playerAId
        ? sanitizeName(pairing.playerA.displayName)
        : g.winnerId === pairing.playerBId
          ? sanitizeName(pairing.playerB.displayName)
          : null,
    winnerLives: g.winnerLives,
  }));
  const fallbackCombo =
    pairing.games.length === 0 && (pairing.reportedDeck || pairing.reportedStake)
      ? [pairing.reportedDeck, pairing.reportedStake].filter(Boolean).join(" / ")
      : null;

  // Forfeit/DQ wins are flagged publicly (the "_Win by forfeit / DQ._" line)
  // but the reason stays admin-only — never surface pairing.forfeitReason here.
  const blocks = buildConfirmedResultBlocks({
    seasonLabel: formatSeasonLabel(season),
    divisionName: pairing.division.name,
    divisionUrl: webUrl(`divisions/${pairing.division.id}`),
    playerAName: sanitizeName(pairing.playerA.displayName),
    playerBName: sanitizeName(pairing.playerB.displayName),
    gamesWonA: pairing.gamesWonA,
    gamesWonB: pairing.gamesWonB,
    forfeit: pairing.forfeit,
    matchId: pairing.id,
    games,
    fallbackCombo,
  });

  // Accent color = the division's tier rarity color, falling back to gold
  // for an unexpected/missing tier position.
  const container = new ContainerBuilder().setAccentColor(tierAccentColor(pairing.division.tier.position));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.metaLine));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.headerLine));
  if (blocks.gamesLine) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.gamesLine));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.footerLine));

  // Dispute button — visible inline so a player who sees their result
  // and disagrees can flag it without leaving the channel. Routes to
  // the existing report:dispute handler in src/commands/report.ts which
  // already accepts CONFIRMED pairings (kicks off the dispute flow).
  const disputeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`report:dispute:${pairing.id}`)
      .setLabel("Dispute this result")
      .setStyle(ButtonStyle.Danger),
  );

  // Bot REST is the preferred path because it can attach interactive
  // components (the Dispute button). User-created webhook URLs CAN'T
  // — only application-owned webhooks support components, and that's
  // more setup than just using the bot identity directly.
  if (channelId) {
    try {
      const body: RESTPostAPIChannelMessageJSONBody = {
        flags: MessageFlags.IsComponentsV2,
        components: [container.toJSON(), disputeRow.toJSON()],
        allowed_mentions: { parse: [] },
      };
      await rest().post(Routes.channelMessages(channelId), { body });
      return;
    } catch (err) {
      console.warn("[announceResult] REST post failed:", err);
      // Fall through to webhook if configured — better to post without
      // a button than not post at all.
    }
  }

  // Webhook fallback — posts the container without the dispute button
  // (webhooks don't carry interactive components reliably). Useful
  // when no channel id is configured at all.
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flags: MessageFlags.IsComponentsV2,
          components: [container.toJSON()],
          allowed_mentions: { parse: [] },
        }),
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
  combos: Array<{ deck: string | null; stake: string | null; winnerName?: string | null }>;
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
    title = `🎴 ${sanitizeName(playerA.displayName)} beats ${sanitizeName(playerB.displayName)}`;
    color = 0x9b59b6;
  } else if (winsB > winsA) {
    title = `🎴 ${sanitizeName(playerB.displayName)} beats ${sanitizeName(playerA.displayName)}`;
    color = 0x9b59b6;
  } else {
    title = `🎴 ${sanitizeName(playerA.displayName)} draws ${sanitizeName(playerB.displayName)}`;
    color = 0x95a5a6;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `${sanitizeName(playerA.displayName)} **${winsA}–${winsB}** ${sanitizeName(playerB.displayName)}\n_Casual challenge — not counted toward standings._`,
    )
    .setColor(color)
    .setFooter({ text: "Challenge" })
    .setTimestamp(new Date());
  // One line per game: what was played and who took it. This post outlives the
  // match thread (deleted shortly after the match), so it's the lasting record.
  const played = opts.combos
    .map((c, i) => {
      const v = [c.deck, c.stake].filter(Boolean).join(" / ");
      if (!v && !c.winnerName) return null;
      const combo = v || "_combo not recorded_";
      const who = c.winnerName ? ` — **${sanitizeName(c.winnerName)}**` : "";
      return `Game ${i + 1}: ${combo}${who}`;
    })
    .filter(Boolean) as string[];
  if (played.length > 0) {
    embed.addFields({ name: "🃏 Games", value: played.join("\n"), inline: false });
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
