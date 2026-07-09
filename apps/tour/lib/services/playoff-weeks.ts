// Playoff rounds are modeled as pseudo-weeks that sit just after the regular season, so the
// week-based roster derivation (deriveLineup) handles playoff subs with no new branching --
// a "Semifinal sub" is just a SUB move at that round's pseudo-week. The UI shows the round
// name with the pseudo-week in parentheses, e.g. "Semi (W10)".
//
// The bracket depth is NOT hard-coded: a round is identified by how many teams enter it
// (2 = Final, 4 = Semifinal, ... 64 = Round of 64), and its pseudo-week is derived from the
// field size so bigger brackets simply get more rounds (Round of 16 -> QF -> SF -> Final).
// Pure helpers (regularWeeks + fieldSize in, values out) live here; the impure loaders read
// the season's regular-week count and playoff field size.
import { prisma } from "../db";

// Teams entering each round -> round name (matches the PlayoffRound enum).
export const TEAMS_BY_ROUND: Record<string, number> = {
  ROUND_OF_64: 64, ROUND_OF_32: 32, ROUND_OF_16: 16, QUARTERFINAL: 8, SEMIFINAL: 4, FINAL: 2,
};
export const ROUND_BY_TEAMS: Record<number, string> = { 64: "ROUND_OF_64", 32: "ROUND_OF_32", 16: "ROUND_OF_16", 8: "QUARTERFINAL", 4: "SEMIFINAL", 2: "FINAL" };
export const ROUND_LABEL: Record<string, string> = {
  ROUND_OF_64: "Round of 64", ROUND_OF_32: "Round of 32", ROUND_OF_16: "Round of 16", QUARTERFINAL: "Quarterfinal", SEMIFINAL: "Semifinal", FINAL: "Final",
};
export const ROUND_SHORT: Record<string, string> = {
  ROUND_OF_64: "R64", ROUND_OF_32: "R32", ROUND_OF_16: "R16", QUARTERFINAL: "QF", SEMIFINAL: "Semi", FINAL: "Final",
};

// The ordered round names for a single-elim field of `fieldSize` teams (power of 2),
// first round first -> e.g. 8 => [QUARTERFINAL, SEMIFINAL, FINAL]; 16 => [ROUND_OF_16, ...].
export function playoffRounds(fieldSize: number): string[] {
  const out: string[] = [];
  for (let t = fieldSize; t >= 2; t = Math.floor(t / 2)) {
    const r = ROUND_BY_TEAMS[t];
    if (r) out.push(r);
  }
  return out;
}

// Number of playoff rounds for a field size (log2, floored to the known rounds).
export function playoffRoundCount(fieldSize: number): number {
  return playoffRounds(fieldSize).length;
}

// The pseudo-week a round sits in, given the field size (gapless: first round = regularWeeks+1).
export function roundWeekOf(regularWeeks: number, fieldSize: number, round: string): number {
  const idx = playoffRounds(fieldSize).indexOf(round);
  return regularWeeks + (idx < 0 ? 0 : idx) + 1;
}

// Whether a (pseudo-)week is a playoff round for a field of this size.
export function isPlayoffWeek(regularWeeks: number, fieldSize: number, week: number): boolean {
  return week > regularWeeks && week <= regularWeeks + playoffRoundCount(fieldSize);
}

// Label a (pseudo-)week for display. Regular -> "W3"; playoff -> "Semi (W10)".
export function weekLabel(regularWeeks: number, fieldSize: number, week: number): string {
  if (week <= regularWeeks) return `W${week}`;
  const round = playoffRounds(fieldSize)[week - regularWeeks - 1];
  return round ? `${ROUND_SHORT[round]} (W${week})` : `W${week}`;
}

// Compact label for a window of (pseudo-)weeks, collapsing a range: "W4-8", "Semi (W10)".
export function windowLabel(regularWeeks: number, fieldSize: number, from: number, until: number | null): string {
  const end = until ?? from;
  if (end === from) return weekLabel(regularWeeks, fieldSize, from);
  return `${weekLabel(regularWeeks, fieldSize, from)}-${weekLabel(regularWeeks, fieldSize, end)}`;
}

// Options for a week/round picker: regular weeks first, then the playoff rounds for the field.
export function weekOptions(regularWeeks: number, fieldSize: number): { value: number; label: string; playoff: boolean }[] {
  const reg = Array.from({ length: regularWeeks }, (_, i) => ({ value: i + 1, label: `Week ${i + 1}`, playoff: false }));
  const po = playoffRounds(fieldSize).map((r, i) => ({ value: regularWeeks + i + 1, label: `${ROUND_LABEL[r]} (W${regularWeeks + i + 1})`, playoff: true }));
  return [...reg, ...po];
}

// Impure: the season's regular-week count -- the largest scheduled non-playoff week, falling
// back to the largest REGULAR set week for imported seasons that have no Week rows.
export async function regularWeekCount(seasonId: string): Promise<number> {
  const wk = await prisma.week.aggregate({ where: { seasonId, kind: { not: "PLAYOFF" } }, _max: { number: true } });
  if (wk._max.number) return wk._max.number;
  const set = await prisma.tourSet.aggregate({ where: { seasonId, bracket: "REGULAR" }, _max: { week: true } });
  return set._max.week ?? 0;
}

// Impure: the playoff field size (bracket team count) for a season.
export async function playoffFieldSize(seasonId: string): Promise<number> {
  const s = await prisma.tourSeason.findUnique({ where: { id: seasonId }, select: { playoffTeams: true } });
  return s?.playoffTeams ?? 8;
}
