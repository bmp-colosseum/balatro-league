// Builds the Components-V2 report container shown on a result post
// (CONFIRMED / AUTO_CONFIRMED / DISPUTED -- the PENDING pending-report stage
// with Confirm/Dispute buttons was removed once results started counting
// straight away; see docs/handbook/matches-and-results.md).

import {
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { buildReportMessageBlocks, type ReportStatus } from "./result-message-core.js";
import { sanitizeName } from "./sanitize.js";
import { mentionWithHandle, type MentionSubject } from "./mention.js";
import { matchRef } from "./match-ref.js";

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
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Match ref ${matchRef(pairingId)}`));
  return container;
}
