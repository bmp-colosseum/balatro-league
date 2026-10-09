// Pure helpers for the v2 "Card Table" standings player cards
// (components/DivisionStandingsTable.tsx) -- no React, no I/O. The shell
// calls these per row with plain data and renders the result.

// One pip per match result in the "hand" strip next to a player's record.
// There is no per-match play-order data available yet (only aggregate
// wins/draws/losses counts), so the hand is ordered by count: every win
// pip, then every draw pip, then every loss pip.
export type RecordPipKind = "win" | "draw" | "loss";

// Negative/non-integer counts (shouldn't happen upstream, but this stays
// pure and total either way) floor to zero pips rather than throwing.
function safeCount(n: number): number {
  return Math.max(0, Math.trunc(n));
}

export function recordPips(wins: number, draws: number, losses: number): RecordPipKind[] {
  const pips: RecordPipKind[] = [];
  for (let i = 0; i < safeCount(wins); i++) pips.push("win");
  for (let i = 0; i < safeCount(draws); i++) pips.push("draw");
  for (let i = 0; i < safeCount(losses); i++) pips.push("loss");
  return pips;
}

// Up to 2 uppercase letters/digits for the player card's avatar fallback
// circle -- first alnum character of each of the first two whitespace-
// separated words, or the first two alnum characters of a single word.
// Punctuation/symbols/emoji in a name are stripped before extracting, so
// e.g. a leading decorative character never becomes part of the initials.
// Falls back to "?" when the display name has no letters/digits at all.
export function initials(displayName: string): string {
  const words = displayName
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0);
  if (words.length >= 2) {
    return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return "?";
}
