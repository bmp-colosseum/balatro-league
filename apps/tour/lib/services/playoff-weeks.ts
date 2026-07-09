// Playoff rounds are modeled as pseudo-weeks that sit just after the regular season, so the
// week-based roster derivation (deriveLineup) handles playoff subs with no new branching --
// a "Semifinal sub" is just a SUB move at week = regularWeeks + 2. The UI shows the round
// name with the pseudo-week in parentheses, e.g. "Semi (W10)".
//
// Pure functions (regularWeeks in, values out) live here for the picker + the display; the
// single impure loader reads the season's regular-week count.
import { prisma } from "../db";

export const PLAYOFF_ROUNDS = [
  { key: "QF", short: "QF", label: "Quarterfinal", offset: 1 },
  { key: "SF", short: "Semi", label: "Semifinal", offset: 2 },
  { key: "F", short: "Final", label: "Final", offset: 3 },
] as const;

export type PlayoffRoundKey = (typeof PLAYOFF_ROUNDS)[number]["key"];

// The pseudo-week for a playoff round given the season's regular-week count.
export function roundWeek(regularWeeks: number, key: PlayoffRoundKey): number {
  const r = PLAYOFF_ROUNDS.find((x) => x.key === key);
  return regularWeeks + (r?.offset ?? 0);
}

// Whether a (pseudo-)week is a playoff round.
export function isPlayoffWeek(regularWeeks: number, week: number): boolean {
  return week > regularWeeks && week <= regularWeeks + PLAYOFF_ROUNDS.length;
}

// Label a week for display. Regular -> "W3"; playoff -> "Semi (W10)".
export function weekLabel(regularWeeks: number, week: number): string {
  if (week <= regularWeeks) return `W${week}`;
  const r = PLAYOFF_ROUNDS.find((x) => x.offset === week - regularWeeks);
  return r ? `${r.short} (W${week})` : `W${week}`;
}

// Compact label for a window of (pseudo-)weeks, collapsing a range: "W4-8", "Semi (W10)",
// "W8-Final". Used by the sub-window display.
export function windowLabel(regularWeeks: number, from: number, until: number | null): string {
  const end = until ?? from;
  if (end === from) return weekLabel(regularWeeks, from);
  return `${weekLabel(regularWeeks, from)}-${weekLabel(regularWeeks, end)}`;
}

// Options for a week/round picker: regular weeks first, then the playoff rounds.
export function weekOptions(regularWeeks: number): { week: number; label: string; playoff: boolean }[] {
  const reg = Array.from({ length: regularWeeks }, (_, i) => ({ week: i + 1, label: `Week ${i + 1}`, playoff: false }));
  const po = PLAYOFF_ROUNDS.map((r) => ({ week: regularWeeks + r.offset, label: `${r.label} (W${regularWeeks + r.offset})`, playoff: true }));
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
