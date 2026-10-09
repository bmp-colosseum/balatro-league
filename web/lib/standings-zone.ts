// Pure helpers for the v2 "Card Table" standings table's zone markup --
// which rows sit in the promotion/relegation zone, and where the dashed
// divider between zones belongs. No React, no I/O -- the shell
// (DivisionStandingsTable) calls these per row with plain data.

export interface ZoneExtras {
  promoting?: boolean;
  relegating?: boolean;
  clinchStatus?: "up" | "down";
}

export type Zone = "promote" | "relegate" | undefined;

// A row counts as "promoting" once it's either decided (promoting) or
// mid-season clinched (clinchStatus "up"); same for relegating/"down".
// promoting is checked first, so a row that is somehow flagged both ways
// (shouldn't happen upstream) reads as promoting.
export function zoneOf(ex: ZoneExtras | undefined): Zone {
  if (ex?.promoting || ex?.clinchStatus === "up") return "promote";
  if (ex?.relegating || ex?.clinchStatus === "down") return "relegate";
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
// show, and in what order -- promote, then relegate, then the tiebreak-note
// legend. `above`/`below` are the neighboring divisions' names in ladder
// order (the division this one promotes into / relegates into); when a line
// applies but no neighbor name is available, it falls back to the bare verb
// instead of guessing a name. The caller (DivisionStandingsTable) renders
// each line's markup (swatch color, <em> on the tiebreak line) by `kind` --
// this function only decides WHICH lines apply and their exact wording.
export interface ZoneKeyLinesInput {
  promote: boolean;
  relegate: boolean;
  above?: string;
  below?: string;
  hasTieNotes: boolean;
}

export type ZoneKeyLine =
  | { kind: "promote"; text: string }
  | { kind: "relegate"; text: string }
  | { kind: "tieNote"; text: string };

export function zoneKeyLines(input: ZoneKeyLinesInput): ZoneKeyLine[] {
  const lines: ZoneKeyLine[] = [];
  if (input.promote) {
    lines.push({ kind: "promote", text: input.above ? `Promotes to ${input.above}` : "Promotes" });
  }
  if (input.relegate) {
    lines.push({ kind: "relegate", text: input.below ? `Drops to ${input.below}` : "Drops" });
  }
  if (input.hasTieNotes) {
    lines.push({ kind: "tieNote", text: "Italic note = how a tie was broken" });
  }
  return lines;
}
