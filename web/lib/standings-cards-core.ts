// Pure helpers for the v2 "Card Table" standings player cards
// (components/DivisionStandingsTable.tsx) -- no React, no I/O. The shell
// calls these per row with plain data and renders the result.
//
// tiebreakDecidedPhrase and its types live in ./tiebreak-text (synced from
// the bot's src/tiebreak-text.ts -- see web/scripts/sync-schema.mjs) so the
// per-row tiebreakNote (lib/standings.ts), this file's own merged tie
// footnote, and the bot's Discord standings post all share one wording
// source. Re-exported here (rather than every caller importing
// ./tiebreak-text directly) so existing call sites -- lib/standings.ts,
// lib/loaders/division.ts, this file's own test -- keep importing from
// "@/lib/standings-cards-core" unchanged.

import {
  tiebreakDecidedPhrase,
  type TiebreakDecisionKind,
  type TiebreakDecidedKind,
  type TiebreakWordingValues,
} from "./tiebreak-text";

export { tiebreakDecidedPhrase };
export type { TiebreakDecisionKind, TiebreakDecidedKind, TiebreakWordingValues };

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
  // See StandingRow.tiebreakKind/tiebreakValues in lib/standings.ts. Absent
  // on a row built before these fields existed (e.g. a cache payload
  // written by an older deploy, or a hand-built test row) -- groupKind below
  // then falls back to the original netLives-presence-only inference so
  // those callers keep their exact previous (final-only) wording.
  tiebreakKind?: TiebreakDecisionKind;
  tiebreakValues?: TiebreakWordingValues;
  // True when THIS row's promotion/relegation fate is already clinched --
  // StandingsRowExtras.clinchStatus is set (components/DivisionStandingsTable.tsx).
  // A group is treated as final (see groupTiebreakNotes' divisionComplete
  // param) once every one of its members is clinched, even mid-season.
  clinched?: boolean;
}

// A group's tiebreakKind when every member agrees on the same one --
// undefined when any row lacks it, or members disagree (can only happen if
// a caller hand-builds inconsistent rows; every real pipeline sets the same
// kind on every member of a group, see orderLivesPointsGroup). undefined
// signals groupTiebreakNotes to use its legacy, kind-blind fallback wording
// instead of guessing.
function groupKind(group: readonly TiebreakNoteRow[]): TiebreakDecisionKind | undefined {
  const first = group[0]?.tiebreakKind;
  if (first === undefined) return undefined;
  return group.every((r) => r.tiebreakKind === first) ? first : undefined;
}

// The values tiebreakDecidedPhrase needs for a GROUP's merged sentence (as
// opposed to one row's own perspective). "netLives" shares one list across
// every member (read straight off each row's netLives, same as before this
// field existed); the two head-to-head kinds and shootout are only ever
// exactly-2-row groups (a 3+-way tie is always net-lives-only -- see
// orderLivesPointsGroup), so the first row's own tiebreakValues already has
// everything tiebreakDecidedPhrase needs.
function groupValues(kind: TiebreakDecidedKind, group: readonly TiebreakNoteRow[]): TiebreakWordingValues {
  if (kind === "netLives") return { livesList: group.map((r) => r.netLives ?? 0) };
  return group[0]?.tiebreakValues ?? {};
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
// When every row in the group agrees on a tiebreakKind (the normal case --
// see orderLivesPointsGroup, which sets the same kind on every member of a
// group), the footnote names every participant plus the kind-appropriate
// clause from tiebreakDecidedPhrase, e.g. "Birb, Frankdeslimste and
// Mangoman007 tied on points: total net lives decided it (-4 / -5 / -7)"
// once isFinal, or "...tied on points; net lives currently separate them
// (-4 / -5 / -7)" while the division is still being played. "realTie" never
// takes a "decided it" clause in either state -- nothing was decided, it's
// an unbreakable tie sharing a rank.
//
// Falls back to the original, kind-blind wording (always the "final"
// phrasing) when any row lacks tiebreakKind -- a hand-built test row, or a
// cache payload written before this field existed: every row carries
// netLives -> the old "total net lives decided it" line; otherwise (no
// shared number list to quote) a plain "tied on points" line naming every
// participant.
//
// divisionComplete is the one caller-known fact that always makes a group
// final (every match in the division has been played). A group can ALSO be
// final before that: once every one of its members is individually
// clinched (StandingsRowExtras.clinchStatus, surfaced per row as
// `clinched` -- see TiebreakNoteRow), that group's relative order can no
// longer change regardless of what's left to play, so "decided it" is
// already accurate.
export function groupTiebreakNotes(rows: readonly TiebreakNoteRow[], divisionComplete: boolean): TiebreakNoteGroup[] {
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
    const isFinal = divisionComplete || group.every((r) => r.clinched === true);
    const allHaveLives = group.every((r) => r.netLives !== undefined);
    // Nothing to report when every tied player's net lives are 0 -- that's
    // the all-zero signature of an early-season / no-matches-played group
    // (see noMatchesYet in DivisionStandingsTable.tsx), where "tied on
    // points -- total net lives decided it (0 / 0 / 0)" is just noise, not
    // a real tiebreak. Skip the group entirely rather than emit it.
    if (allHaveLives && group.every((r) => r.netLives === 0)) {
      i = j;
      continue;
    }
    const names = group.map((r) => r.player.displayName);
    const kind = groupKind(group);
    let text: string;
    if (kind === undefined) {
      const lives = group.map((r) => `${r.netLives}`).join(" / ");
      text = !allHaveLives
        ? `${joinNames(names)} tied on points`
        : isFinal
          ? `${joinNames(names)} tied on points: total net lives decided it (${lives})`
          : `${joinNames(names)} tied on points; net lives currently separate them (${lives})`;
    } else if (kind === "realTie") {
      text = `${joinNames(names)} tied on points and net lives -- shares the place`;
    } else {
      const connector = isFinal ? ":" : ";";
      const phrase = tiebreakDecidedPhrase(kind, groupValues(kind, group), isFinal);
      text = `${joinNames(names)} tied on points${connector} ${phrase}`;
    }
    groups.push({ lastIndex: j - 1, text });
    i = j;
  }
  return groups;
}

// "Birb leads . 2/10" (or "none played" before anything's been played) --
// the faint meta line next to the phone-collapsed division summary's own
// tier-coloured name (see components/CollapsibleDivision.tsx,
// app/standings/page.tsx). The division name used to be baked into this
// same string; it now renders as its own element so it can carry the tier
// colour, so this only returns the leader/progress half. Pure string
// composition from already-derived plain values; the caller decides who the
// "leader" is (rows[0] after sorting/ranking) and passes its name through.
export function divisionSummaryLine(input: {
  leaderName?: string;
  playedMatches: number;
  expectedMatches: number;
}): string {
  if (input.playedMatches === 0 || !input.leaderName) {
    return "none played";
  }
  return `${input.leaderName} leads . ${input.playedMatches}/${input.expectedMatches}`;
}
