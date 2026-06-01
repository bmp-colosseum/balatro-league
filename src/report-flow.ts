// Plumbing for the opponent-confirms reporting flow:
//   1. /report or web report creates a PENDING Pairing (in src/reporting.ts)
//   2. postPendingReport() lands the public embed in #results with
//      Confirm/Dispute buttons + pings opponent
//   3. enqueueAutoConfirm() schedules a pg-boss job for +2min that
//      promotes the pairing to CONFIRMED if no one acted yet
//   4. Confirm button → finalizeReport(CONFIRMED) → edit embed,
//      recompute standings, announce
//   5. Dispute button → finalizeReport(DISPUTED) → edit embed, spawn
//      a public thread under #results with players + helpers pinged

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { env } from "./env.js";
import { resolveBotCommandsChannelId } from "./bot-commands-channel.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";

// Resolve the results channel id with the same precedence the announce
// path uses: season override → global LeagueConfig → env. Falls back
// to #bot-commands when nothing is configured so the buttons still
// land somewhere players can see them.
export async function resolveReportChannelId(seasonId: string | null): Promise<string | null> {
  if (seasonId) {
    const season = await prisma.season.findUnique({
      where: { id: seasonId },
      select: { resultsChannelId: true },
    });
    if (season?.resultsChannelId) return season.resultsChannelId;
  }
  if (env.RESULTS_CHANNEL_ID) return env.RESULTS_CHANNEL_ID;
  const global = await getConfig(LeagueConfigKey.ResultsWebhookUrl);
  if (global && global.startsWith("https://")) {
    // Webhook URL — not a channel id, can't post buttons against it.
    // Skip and fall back to bot-commands.
  }
  return resolveBotCommandsChannelId();
}

// Build the report embed in its current state (PENDING / CONFIRMED /
// AUTO_CONFIRMED / DISPUTED). Used by both initial post + every edit.
export function buildReportEmbed(args: {
  status: "PENDING" | "CONFIRMED" | "AUTO_CONFIRMED" | "DISPUTED";
  reporter: { displayName: string; discordId: string };
  opponent: { displayName: string; discordId: string };
  divisionName: string;
  result: { gamesWonA: number; gamesWonB: number };
  reporterIsA: boolean;
  pairingId: string;
}): EmbedBuilder {
  const { status, reporter, opponent, divisionName, result, reporterIsA, pairingId } = args;
  const repGames = reporterIsA ? result.gamesWonA : result.gamesWonB;
  const oppGames = reporterIsA ? result.gamesWonB : result.gamesWonA;
  const scoreline = `${reporter.displayName} **${repGames}-${oppGames}** ${opponent.displayName}`;
  const verdict =
    repGames === 2 && oppGames === 0 ? `🏆 ${reporter.displayName} swept`
    : repGames === 0 && oppGames === 2 ? `🏆 ${opponent.displayName} swept`
    : `🤝 ${reporter.displayName} and ${opponent.displayName} drew 1-1`;
  let title: string;
  let color: number;
  let description: string;
  switch (status) {
    case "PENDING":
      title = "📝 Match reported — awaiting opponent";
      color = 0xf1c40f;
      description =
        `${scoreline}\n_in **${divisionName}**_\n\n` +
        `<@${opponent.discordId}>, please **Confirm** or **Dispute** within 2 minutes.\n` +
        `_If no action, the result auto-confirms._`;
      break;
    case "CONFIRMED":
      title = "✅ Match confirmed";
      color = 0x2ecc71;
      description = `${verdict}\n${scoreline}\n_in **${divisionName}**_`;
      break;
    case "AUTO_CONFIRMED":
      title = "✅ Match confirmed (auto)";
      color = 0x2ecc71;
      description =
        `${verdict}\n${scoreline}\n_in **${divisionName}**_\n\n` +
        `_Auto-confirmed after 2 minutes — opponent didn't respond._`;
      break;
    case "DISPUTED":
      title = "⚠ Match disputed";
      color = 0xe74c3c;
      description =
        `${scoreline}\n_in **${divisionName}**_\n\n` +
        `<@${opponent.discordId}> disputed the result. A helper has been pinged in the thread below.`;
      break;
  }
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: `Match ${pairingId}` });
}

export function pendingButtons(pairingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`report:confirm:${pairingId}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`report:dispute:${pairingId}`)
      .setLabel("Dispute")
      .setStyle(ButtonStyle.Danger),
  );
}

// Post the PENDING report embed to #results and stash channel+message
// ids on the Pairing row so button handlers + the 2-min auto-confirm
// job can edit in place. Best-effort: a failed post still leaves the
// Pairing in PENDING, and auto-confirm will fire from the queue.
export async function postPendingReport(pairingId: string): Promise<void> {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: {
      playerA: true,
      playerB: true,
      division: { include: { season: { select: { id: true, resultsChannelId: true } } } },
    },
  });
  if (!pairing) return;
  if (pairing.status !== "PENDING") return;

  const client = tryGetDiscordClient();
  if (!client) {
    console.warn(`[report-flow] client not ready, can't post pending report ${pairingId}`);
    return;
  }
  const channelId = await resolveReportChannelId(pairing.division.season.id);
  if (!channelId) {
    console.warn(`[report-flow] no destination channel resolved for pairing ${pairingId}`);
    return;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const reporterIsA = pairing.reporterId === pairing.playerAId;
    const reporter = reporterIsA ? pairing.playerA : pairing.playerB;
    const opponent = reporterIsA ? pairing.playerB : pairing.playerA;
    const embed = buildReportEmbed({
      status: "PENDING",
      reporter,
      opponent,
      divisionName: pairing.division.name,
      result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      reporterIsA,
      pairingId: pairing.id,
    });
    const message = await (channel as TextChannel).send({
      content: `<@${opponent.discordId}> match reported against you`,
      embeds: [embed],
      components: [pendingButtons(pairingId)],
    });
    await prisma.pairing.update({
      where: { id: pairingId },
      data: { reportChannelId: channelId, reportMessageId: message.id },
    });
    void AttachmentBuilder; // silence unused-import linter; reserved for future expansion
  } catch (err) {
    console.warn(`[report-flow] post failed for ${pairingId}:`, err);
  }
}
