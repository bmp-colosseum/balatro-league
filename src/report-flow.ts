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
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  type TextChannel,
} from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { env } from "./env.js";
import { resolveBotCommandsChannelId } from "./bot-commands-channel.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { buildReportMessageBlocks, type ReportStatus } from "./result-message-core.js";
import { sanitizeName } from "./sanitize.js";
import { mentionWithHandle, type MentionSubject } from "./mention.js";

// Resolve the results channel id with the same precedence the announce
// path uses: season override → global LeagueConfig → env. Falls back
// to #bot-commands when nothing is configured so the buttons still
// land somewhere players can see them.
async function resolveReportChannelId(seasonId: string | null): Promise<string | null> {
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

// Accent color per status -- same palette the original embed's setColor used.
const STATUS_ACCENT_COLOR: Record<ReportStatus, number> = {
  PENDING: 0xf1c40f,
  CONFIRMED: 0x2ecc71,
  AUTO_CONFIRMED: 0x2ecc71,
  DISPUTED: 0xe74c3c,
};

// Build the report container in its current state (PENDING / CONFIRMED /
// AUTO_CONFIRMED / DISPUTED). Used by both initial post + every edit -- a
// Components V2 message can't carry embeds, so this returns a ContainerBuilder
// (a top-level component) instead of an EmbedBuilder.
export function buildReportContainer(args: {
  status: ReportStatus;
  reporter: { displayName: string } & MentionSubject;
  opponent: { displayName: string } & MentionSubject;
  divisionName: string;
  result: { gamesWonA: number; gamesWonB: number };
  reporterIsA: boolean;
  pairingId: string;
  // Optional combo captured on the report — shown as its own line when present.
  combo?: { deck?: string | null; stake?: string | null };
}): ContainerBuilder {
  const { status, reporter, opponent, divisionName, result, reporterIsA, pairingId, combo } = args;
  const blocks = buildReportMessageBlocks({
    status,
    divisionName,
    reporterName: sanitizeName(reporter.displayName),
    opponentName: sanitizeName(opponent.displayName),
    opponentMention: mentionWithHandle(opponent),
    reporterIsA,
    gamesWonA: result.gamesWonA,
    gamesWonB: result.gamesWonB,
    combo,
  });

  const container = new ContainerBuilder().setAccentColor(STATUS_ACCENT_COLOR[status]);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.metaLine));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.headerLine));
  if (blocks.bodyLine) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.bodyLine));
  }
  if (blocks.comboLine) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blocks.comboLine));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Match ${pairingId}`));
  return container;
}

function pendingButtons(pairingId: string): ActionRowBuilder<ButtonBuilder> {
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
  const pairing = await prisma.match.findUnique({
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
    const container = buildReportContainer({
      status: "PENDING",
      reporter,
      opponent,
      divisionName: pairing.division.name,
      result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      reporterIsA,
      pairingId: pairing.id,
      combo: { deck: pairing.reportedDeck, stake: pairing.reportedStake },
    });
    // The opponent-ping lives in the container body now (a Components V2
    // message can't carry `content`) -- allowedMentions is scoped to just
    // their id so nothing else in the container can ping by accident.
    const message = await (channel as TextChannel).send({
      flags: MessageFlags.IsComponentsV2,
      components: [container, pendingButtons(pairingId)],
      allowedMentions: { users: [opponent.discordId] },
    });
    await prisma.match.update({
      where: { id: pairingId },
      data: { reportChannelId: channelId, reportMessageId: message.id },
    });
    void AttachmentBuilder; // silence unused-import linter; reserved for future expansion
  } catch (err) {
    console.warn(`[report-flow] post failed for ${pairingId}:`, err);
  }
}
