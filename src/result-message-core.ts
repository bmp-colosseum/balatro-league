// Pure text assembly for the Components V2 result posts (announce.ts's
// confirmed-result channel post, report-flow.ts's pending/confirmed/
// auto-confirmed/disputed report post). No discord.js, no Prisma, no Date --
// callers hand in already-sanitized plain strings/numbers and get back plain
// strings they drop into TextDisplayBuilder content. Keeping this pure means
// every branch (draw vs sweep, forfeit, missing emoji, missing lives, missing
// Game rows) is a literal-in/literal-out unit test with no Discord client or
// database involved.

// ---------------------------------------------------------------------------
// Confirmed-result channel post (src/announce.ts's announceResult)
// ---------------------------------------------------------------------------

export interface GameLineInput {
  num: number;
  deck: string | null;
  stake: string | null;
  // Pre-resolved mention strings from src/balatro-emojis.ts (deckEmoji/
  // stakeEmoji), or null when no emoji is uploaded for that deck/stake.
  deckEmoji: string | null;
  stakeEmoji: string | null;
  // Already-sanitized winner display name, or null when no winner is on
  // record for this game.
  winnerName: string | null;
  // Lives the winner had remaining at the end of the game, or null when not
  // captured (manual report, forfeit, pre-feature games).
  winnerLives: number | null;
}

export interface ConfirmedResultInput {
  seasonLabel: string; // e.g. "Season 4" or "Season 4 - Launch" (formatSeasonLabel)
  divisionName: string;
  divisionUrl: string;
  playerAName: string; // already sanitized
  playerBName: string; // already sanitized
  gamesWonA: number;
  gamesWonB: number;
  forfeit: boolean;
  matchId: string;
  games: readonly GameLineInput[];
  // The legacy reportedDeck/reportedStake combo, used only when `games` is
  // empty (matches recorded before Game rows existed, or via the old
  // /report path). Null when there's nothing to fall back to.
  fallbackCombo: string | null;
}

export interface ConfirmedResultBlocks {
  metaLine: string;
  headerLine: string;
  gamesLine: string | null;
  footerLine: string;
}

function markdownLink(text: string, url: string): string {
  return `[${text}](${url})`;
}

export function confirmedMetaLine(input: Pick<ConfirmedResultInput, "seasonLabel" | "divisionName">): string {
  return `### ${input.seasonLabel} - ${input.divisionName}`;
}

// "Alice beats Bob" / "Alice draws Bob", winner (or A, on a draw) named first.
export function confirmedHeaderText(
  input: Pick<ConfirmedResultInput, "playerAName" | "playerBName" | "gamesWonA" | "gamesWonB">,
): string {
  const { playerAName, playerBName, gamesWonA, gamesWonB } = input;
  if (gamesWonA === gamesWonB) {
    return `**${playerAName} draws ${playerBName}** ${gamesWonA}-${gamesWonB}`;
  }
  const aWins = gamesWonA > gamesWonB;
  const winner = aWins ? playerAName : playerBName;
  const loser = aWins ? playerBName : playerAName;
  const winnerGames = Math.max(gamesWonA, gamesWonB);
  const loserGames = Math.min(gamesWonA, gamesWonB);
  return `**${winner} beats ${loser}** ${winnerGames}-${loserGames}`;
}

export function confirmedHeaderLine(
  input: Pick<ConfirmedResultInput, "playerAName" | "playerBName" | "gamesWonA" | "gamesWonB" | "divisionUrl" | "forfeit">,
): string {
  const header = `## ${markdownLink(confirmedHeaderText(input), input.divisionUrl)}`;
  return input.forfeit ? `${header}\n_Win by forfeit / DQ._` : header;
}

// One line per game: "{deckEmoji}{stakeEmoji} 1. Deck / Stake - **Winner** (N
// lives left)". Returns null when the game has neither a recorded combo nor a
// recorded winner (nothing worth a line).
export function confirmedGameLine(game: GameLineInput): string | null {
  const combo = [game.deck, game.stake].filter((v): v is string => Boolean(v)).join(" / ");
  if (!combo && !game.winnerName) return null;
  const icons = `${game.deckEmoji ?? ""}${game.stakeEmoji ?? ""}`;
  const prefix = icons ? `${icons} ` : "";
  const comboText = combo || "_combo not recorded_";
  const livesSuffix = game.winnerName && game.winnerLives != null ? ` (${game.winnerLives} lives left)` : "";
  const who = game.winnerName ? ` - **${game.winnerName}**${livesSuffix}` : "";
  return `${prefix}${game.num}. ${comboText}${who}`;
}

// The per-game breakdown block, or the legacy single-line fallback when there
// are no Game rows at all, or null when there's nothing to show.
export function confirmedGamesLines(games: readonly GameLineInput[], fallbackCombo: string | null): string | null {
  const lines = games.map(confirmedGameLine).filter((line): line is string => line !== null);
  if (lines.length > 0) return lines.join("\n");
  if (fallbackCombo) return `Played: ${fallbackCombo}`;
  return null;
}

export function confirmedFooterLine(matchId: string): string {
  return `-# Match ${matchId}`;
}

export function buildConfirmedResultBlocks(input: ConfirmedResultInput): ConfirmedResultBlocks {
  return {
    metaLine: confirmedMetaLine(input),
    headerLine: confirmedHeaderLine(input),
    gamesLine: confirmedGamesLines(input.games, input.fallbackCombo),
    footerLine: confirmedFooterLine(input.matchId),
  };
}

// ---------------------------------------------------------------------------
// Report-flow post (src/report-flow.ts's buildReportContainer): the same
// message, edited in place as it moves PENDING -> CONFIRMED | AUTO_CONFIRMED
// | DISPUTED.
// ---------------------------------------------------------------------------

export type ReportStatus = "PENDING" | "CONFIRMED" | "AUTO_CONFIRMED" | "DISPUTED";

export interface ReportMessageInput {
  status: ReportStatus;
  divisionName: string;
  reporterName: string; // already sanitized
  opponentName: string; // already sanitized
  opponentMention: string; // mentionWithHandle(opponent), precomputed by the shell
  reporterIsA: boolean;
  gamesWonA: number;
  gamesWonB: number;
  // Optional combo captured on the report -- shown as its own line when present.
  combo?: { deck?: string | null; stake?: string | null };
}

export interface ReportMessageBlocks {
  metaLine: string;
  headerLine: string;
  bodyLine: string | null;
  comboLine: string | null;
}

function reportScoreline(
  input: Pick<ReportMessageInput, "reporterName" | "opponentName" | "reporterIsA" | "gamesWonA" | "gamesWonB">,
): { text: string; reporterGames: number; opponentGames: number } {
  const reporterGames = input.reporterIsA ? input.gamesWonA : input.gamesWonB;
  const opponentGames = input.reporterIsA ? input.gamesWonB : input.gamesWonA;
  return {
    text: `${input.reporterName} **${reporterGames}-${opponentGames}** ${input.opponentName}`,
    reporterGames,
    opponentGames,
  };
}

function reportVerdict(reporterName: string, opponentName: string, reporterGames: number, opponentGames: number): string {
  if (reporterGames === 2 && opponentGames === 0) return `**${reporterName} swept**`;
  if (reporterGames === 0 && opponentGames === 2) return `**${opponentName} swept**`;
  return `**${reporterName} and ${opponentName} drew 1-1**`;
}

export function buildReportMessageBlocks(input: ReportMessageInput): ReportMessageBlocks {
  const { status, divisionName, reporterName, opponentName, opponentMention, combo } = input;
  const { text: scoreline, reporterGames, opponentGames } = reportScoreline(input);
  const metaLine = `### ${divisionName}`;

  let headerLine: string;
  let bodyLine: string | null;
  switch (status) {
    case "PENDING":
      headerLine = `## ${reporterName} reports ${reporterGames}-${opponentGames} over ${opponentName}`;
      bodyLine = `${opponentMention}, please **Confirm** or **Dispute** within 2 minutes. Auto-confirms if no response.`;
      break;
    case "CONFIRMED":
      headerLine = `## ${reportVerdict(reporterName, opponentName, reporterGames, opponentGames)}`;
      bodyLine = scoreline;
      break;
    case "AUTO_CONFIRMED":
      headerLine = `## ${reportVerdict(reporterName, opponentName, reporterGames, opponentGames)}`;
      bodyLine = `${scoreline}\n_Auto-confirmed after 2 minutes -- opponent didn't respond._`;
      break;
    case "DISPUTED":
      headerLine = "## Match disputed";
      bodyLine = `${scoreline}\n${opponentMention} disputed the result. A helper has been pinged in the thread below.`;
      break;
  }

  const comboLine =
    combo && (combo.deck || combo.stake) ? `Played: ${[combo.deck, combo.stake].filter(Boolean).join(" / ")}` : null;

  return { metaLine, headerLine, bodyLine, comboLine };
}
