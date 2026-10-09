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

// "A" / "A and B" / "A, B and C" -- a plain-English name list for the merged
// tie footnote below. Small local copy rather than importing src/standings.ts
// / web/lib/standings.ts's identical private helper -- this file stays
// zero-import (see the file header).
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Minimal row shape groupTiebreakNotes needs -- structurally compatible with
// StandingsTableRow (components/DivisionStandingsTable.tsx) without
// importing it (keeps this file at zero imports).
export interface TiebreakNoteRow {
  points: number;
  tiebreakNote?: string;
  netLives?: number;
  player: { displayName: string };
}

export interface TiebreakNoteGroup {
  // Index into the ORIGINAL rows array of the last row in this group -- the
  // shell renders the merged footnote once, right after that row ("under
  // the group").
  lastIndex: number;
  text: string;
}

// Merges a tie group's per-row tiebreakNote sentences (StandingRow.tiebreakNote,
// see lib/standings.ts' orderLivesPointsGroup) into ONE footnote instead of a
// near-duplicate sentence repeated on every tied row.
//
// Rows that were originally tied on points always sit CONSECUTIVELY in the
// standings (points-sorted, and "tied" is defined as equal points), and
// orderLivesPointsGroup sets tiebreakNote on every member of such a group of
// 2+. So a maximal run of consecutive rows that (a) all carry a tiebreakNote
// and (b) all share the same `points` value is exactly one original tie
// group -- grouping on that pair of conditions recovers the group boundaries
// without needing a separate group id on each row.
//
// When every row in the group carries netLives (the common "total net lives
// decided it" case -- see orderLivesPointsGroup, which gives every member of
// such a group the SAME final-order lives list), the footnote names every
// participant plus that shared list, e.g. "Birb, Frankdeslimste and
// Mangoman007 tied on points -- total net lives decided it (-4 / -5 / -7)".
// Otherwise (shootout / head-to-head / an unresolved real tie -- cases whose
// per-row wording differs by the row's own perspective, so there is no single
// shared number list to quote) it falls back to a plain "tied on points" line
// naming every participant.
export function groupTiebreakNotes(rows: readonly TiebreakNoteRow[]): TiebreakNoteGroup[] {
  const groups: TiebreakNoteGroup[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!rows[i]!.tiebreakNote) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j]!.tiebreakNote && rows[j]!.points === rows[i]!.points) j++;
    const group = rows.slice(i, j);
    const names = group.map((r) => r.player.displayName);
    const allHaveLives = group.every((r) => r.netLives !== undefined);
    const text = allHaveLives
      ? `${joinNames(names)} tied on points -- total net lives decided it (${group.map((r) => `${r.netLives}`).join(" / ")})`
      : `${joinNames(names)} tied on points`;
    groups.push({ lastIndex: j - 1, text });
    i = j;
  }
  return groups;
}

// "Rare 2 - leader Birb 9 pts - 4/10 played" (or "Rare 2 - none played"
// before anything's been played) -- the phone-collapsed one-line summary for
// a division that isn't the viewer's own (see app/standings/page.tsx). Pure
// string composition from already-derived plain values; the caller decides
// who the "leader" is (rows[0] after sorting/ranking) and passes its name +
// points through.
export function divisionSummaryLine(input: {
  divisionName: string;
  leaderName?: string;
  leaderPoints?: number;
  playedMatches: number;
  expectedMatches: number;
}): string {
  if (input.playedMatches === 0 || !input.leaderName) {
    return `${input.divisionName} - none played`;
  }
  const pts = input.leaderPoints ?? 0;
  return `${input.divisionName} - leader ${input.leaderName} ${pts} ${pts === 1 ? "pt" : "pts"} - ${input.playedMatches}/${input.expectedMatches} played`;
}
