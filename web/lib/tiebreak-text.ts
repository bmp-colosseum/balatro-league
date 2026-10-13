// Pure tiebreak-note wording -- shared by the bot's standings engine
// (standings.ts's orderLivesPointsGroup, which builds the per-row
// tiebreakNote rendered in the Discord standings post) and, via the synced
// copy web/lib/tiebreak-text.ts (see web/scripts/sync-schema.mjs), the web's
// own per-row tiebreakNote (web/lib/standings.ts) and its v2 "Card Table"
// merged tie footnote (web/lib/standings-cards-core.ts's groupTiebreakNotes).
// One wording source means the per-row note, the merged footnote, and the
// bot's post can never drift. Zero imports.

// Which mechanism decided (or failed to decide) a group of rows originally
// tied on points. "realTie" means nothing was decided (an unbreakable tie
// sharing a rank) -- it never takes "decided it" wording, in either state,
// so it's excluded from TiebreakDecidedKind below.
export type TiebreakDecisionKind =
  | "shootout"
  | "headToHeadResult"
  | "headToHeadLives"
  | "netLives"
  | "realTie";

// The subset of TiebreakDecisionKind that DOES have a "decided it" /
// "currently separate them" clause (see tiebreakDecidedPhrase below).
export type TiebreakDecidedKind = Exclude<TiebreakDecisionKind, "realTie">;

// Raw inputs for tiebreakDecidedPhrase below -- plain values only; all
// formatting (sign, parenthesized list) happens inside that function so
// there is exactly one place that owns the punctuation. Which fields are
// read depends on kind: "headToHeadResult" reads `won`; "headToHeadLives"
// reads `diff` (this row's own signed differential from the one match);
// "netLives" reads `livesList` (every tied row's net lives, in display
// order -- the same list for every row in the group); "shootout" reads
// nothing.
export interface TiebreakWordingValues {
  won?: boolean;
  diff?: number;
  livesList?: number[];
}

// "+N"/"-N" for a signed lives number -- a negative value already carries
// its own "-", a non-negative one needs "+" added.
function formatSignedLives(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// The "decided it" (isFinal) / "currently separate them" (not yet final)
// half of a tiebreak sentence, e.g. "total net lives decided it (3 / -3)"
// vs "net lives currently separate them (+3 / -3)". isFinal is true once
// the division is complete (every match played) or -- for the web's merged
// v2 footnote only -- this specific tie is already clinched/decided per the
// caller's own promote/relegate/clinch logic. Until then more matches could
// still shift the numbers (net lives is a season-long running total) or the
// tie group's membership itself (a third player could still join or leave
// it), so the wording stays present-tense and provisional rather than
// claiming a final verdict already happened. Pure: a plain
// (kind, values, isFinal) -> string mapping, no row/group shape involved --
// callers build their own surrounding sentence around this clause.
export function tiebreakDecidedPhrase(
  kind: TiebreakDecidedKind,
  values: TiebreakWordingValues,
  isFinal: boolean,
): string {
  switch (kind) {
    case "shootout":
      return isFinal ? "shootout decided it" : "a shootout currently separates them";
    case "headToHeadResult":
      if (isFinal) return values.won ? "beat them head-to-head" : "lost to them head-to-head";
      return values.won ? "is currently ahead of them head-to-head" : "is currently behind them head-to-head";
    case "headToHeadLives": {
      const diff = values.diff ?? 0;
      const pair = `${formatSignedLives(diff)} vs ${formatSignedLives(-diff)}`;
      return isFinal ? `head-to-head lives ${pair} decided it` : `head-to-head lives ${pair} currently separate them`;
    }
    case "netLives": {
      const list = (values.livesList ?? []).join(" / ");
      return isFinal ? `total net lives decided it (${list})` : `net lives currently separate them (${list})`;
    }
  }
}
