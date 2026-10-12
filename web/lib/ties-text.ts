// Canonical ties/tiebreak copy, one source for every surface that explains
// the rule to a player: the division welcome, #league-info, the welcome
// guide, and the shootout-owed notices. Before this module each of those
// four described the rule independently and drifted out of sync with the
// actual code (src/standings.ts's orderLivesPointsGroup / sortStandings) and
// with each other -- see docs/handbook/standings-and-tiebreaks.md for the
// authoritative order this mirrors.
//
// No imports -- kept trivially pure so it's unit-testable with plain data
// and safe to mirror to web/lib (via web/scripts/sync-schema.mjs) if a web
// surface ever needs the same copy.

export type SeasonTiebreak = "chain" | "lives";

export interface TiesText {
  // Full explanatory sentence(s), no "Ties:" label and no leading bullet --
  // callers add their own lead-in ("- **Ties:** " / "**Ties:** " / a bold
  // "Ties." heading) so the same sentence slots into a bullet, a paragraph,
  // or a guide section body.
  rule: string;
  // Fragment for the shootout-owed DM/channel ping: why net lives (or
  // head-to-head) didn't already settle it. Lower-case, no leading "and".
  shootoutUnresolvedReason: string;
  // Fragment for the shootout-owed DM/channel ping: the call to action,
  // phrased as mandatory (chain) or optional (lives already found a winner
  // via net lives, so the shootout is just a way to avoid sharing the rank).
  shootoutCallToAction: string;
}

const LIVES_RULE =
  "Two players tied: a confirmed shootout (one extra game) decides it first. " +
  "No shootout? Whoever won your head-to-head 2-0 is ahead; if that match was 1-1, " +
  "the lives from that match decide; still level, total net lives for the season decide. " +
  "Three or more tied: total net lives decide. Net lives = the lives you had left in your " +
  "wins, minus the lives your opponents had left in your losses.";

const CHAIN_RULE =
  "Two or more players tied on points: whoever won your head-to-head 2-0 is ahead. " +
  "Still tied? A confirmed shootout (one extra game) decides it -- play it, because " +
  "without one the tie falls back to total wins, which may not go your way.";

export function tiesText(tiebreak: SeasonTiebreak): TiesText {
  if (tiebreak === "lives") {
    return {
      rule: LIVES_RULE,
      shootoutUnresolvedReason: "and net lives didn't settle it either",
      shootoutCallToAction:
        "A shootout is **optional** -- play **one game** if you'd rather not share the rank: open",
    };
  }
  return {
    rule: CHAIN_RULE,
    shootoutUnresolvedReason: "and your head-to-head didn't settle it",
    shootoutCallToAction: "Play **one game** to decide it: open",
  };
}
