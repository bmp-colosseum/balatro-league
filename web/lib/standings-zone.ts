// Pure helpers for the v2 "Card Table" standings table's zone markup --
// which rows sit in the promotion/relegation zone, and where the dashed
// divider between zones belongs. No React, no I/O -- the shell
// (DivisionStandingsTable) calls these per row with plain data.

export interface ZoneExtras {
  // Decided at season end (every match played).
  promoting?: boolean;
  relegating?: boolean;
  // Mid-season: mathematically certain.
  clinchStatus?: "up" | "down";
  // Mid-season: where the row sits RIGHT NOW (top promoteCount / bottom
  // relegateCount). Drawn as the zone stripe so players can see the line
  // all season, like a playoff line; nothing is decided by it.
  inPromotionSpot?: boolean;
  inRelegationSpot?: boolean;
}

export type Zone = "promote" | "relegate" | undefined;

// A row counts as "promoting" once it's either decided (promoting) or
// mid-season clinched (clinchStatus "up"); same for relegating/"down".
// promoting is checked first, so a row that is somehow flagged both ways
// (shouldn't happen upstream) reads as promoting.
export function zoneOf(ex: ZoneExtras | undefined): Zone {
  // Decided or clinched states win; the current spot only fills in while
  // nothing is settled yet.
  if (ex?.promoting || ex?.clinchStatus === "up") return "promote";
  if (ex?.relegating || ex?.clinchStatus === "down") return "relegate";
  if (ex?.inPromotionSpot) return "promote";
  if (ex?.inRelegationSpot) return "relegate";
  return undefined;
}

// Which colour (if any) the dashed boundary line below row `i` should be.
// The LAST row of the promotion zone gets a gold line, closing it off from
// the rest of the table; the LAST safe row right above the relegation zone
// gets a rare line, marking the drop into it. A row needs only its own zone
// and the next row's zone to detect the transition -- the final row in the
// table never gets a line (nothing below to divide from).
//
// Edge case: a tiny division where the promotion zone touches the
// relegation zone with no safe rows between them -- the shared boundary row
// reads as "promote" (checked first), not "relegate".
export function boundaryBelow(zones: readonly Zone[], i: number): Zone {
  const zone = zones[i];
  const nextZone = i + 1 < zones.length ? zones[i + 1] : undefined;
  if (zone === "promote" && nextZone !== "promote") return "promote";
  if (zone !== "relegate" && nextZone === "relegate") return "relegate";
  return undefined;
}

// Which lines the v2 "Card Table" zone key under a standings table should
// show, and in what order -- promote, then relegate. `above`/`below` are
// the neighboring divisions' names in ladder order (the division this one
// promotes into / relegates into); when a line applies but no neighbor name
// is available, it falls back to the bare verb instead of guessing a name.
// The caller (DivisionStandingsTable) renders each line's markup (swatch
// color) by `kind` -- this function only decides WHICH lines apply and
// their exact wording.
//
// No longer carries a tie-note legend line -- the v2 player-card stack now
// shows one merged footnote per tie GROUP right under that group (see
// groupTiebreakNotes in standings-cards-core.ts), which is self-explanatory,
// so the repeated "Italic note = how a tie was broken" key line this used
// to add is gone.
export interface ZoneKeyLinesInput {
  promote: boolean;
  relegate: boolean;
  above?: string;
  below?: string;
  // True only for the single division sitting at the very top of the WHOLE
  // ladder (web/lib/division-ladder.ts' buildLadder -- its `above` is null).
  // Lets the key say so explicitly instead of silently showing nothing,
  // since that division's promote is always 0 and would otherwise never
  // produce a line here. Only ever set by callers that track full ladder
  // order (undefined -- i.e. no change -- for callers that don't, like the
  // ended-season view).
  isTopOfLadder?: boolean;
}

export type ZoneKeyLine =
  | { kind: "promote"; text: string }
  | { kind: "relegate"; text: string };

export function zoneKeyLines(input: ZoneKeyLinesInput): ZoneKeyLine[] {
  const lines: ZoneKeyLine[] = [];
  if (input.isTopOfLadder) {
    lines.push({ kind: "promote", text: "Top of the ladder" });
  } else if (input.promote) {
    lines.push({ kind: "promote", text: input.above ? `Promotion to ${input.above}` : "Promotion" });
  }
  if (input.relegate) {
    lines.push({ kind: "relegate", text: input.below ? `Relegation to ${input.below}` : "Relegation" });
  }
  return lines;
}

// Text for the dashed zone-boundary divider's "punched through" label (the
// v2 player card's data-boundary ::after content -- see
// app/v2/standings-cards.css). Same "to <neighbor>" wording as the key
// lines above, kept as its own pure function since the divider is per-row
// (keyed off which zone boundary this row sits on) rather than per-division.
export function boundaryLabel(boundary: Zone, above?: string, below?: string): string | undefined {
  if (boundary === "promote") return above ? `Promotion to ${above}` : "Promotion";
  if (boundary === "relegate") return below ? `Relegation to ${below}` : "Relegation";
  return undefined;
}

// Title text for the v2 player card's rank-tile clinch glyph (an inline SVG
// lock, see DivisionStandingsTable's ClinchGlyph) -- kept as a pure lookup
// here so the wording is covered by a plain unit test, same as the rest of
// this module. The v1 table's own RowBadges title strings are unrelated and
// unchanged -- this is v2-only wording.
export function clinchTitle(status: "up" | "down"): string {
  return status === "up" ? "Clinched: guaranteed up" : "Locked: guaranteed down";
}
