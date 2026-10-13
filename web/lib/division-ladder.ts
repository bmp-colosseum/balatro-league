// Pure core: the league's divisions form ONE ladder, not parallel groups.
// Legendary sits at the top, then Rare 1, Rare 2, ..., Uncommon 1, ...,
// Common 1, ..., Common N at the bottom. The top of each division promotes
// into the division directly above it on the ladder (even across a tier
// boundary); the bottom relegates into the division directly below it.
// Nothing here decides promotion/relegation COUNTS -- those are set by hand
// by the tournament organiser per division (Division.promoteCount /
// relegateCount) and passed straight through; this module only establishes
// ORDER and each division's neighbors on that single ladder.
//
// Ladder order matches the convention already used everywhere else in this
// codebase (lib/loaders/standings.ts, lib/loaders/division.ts, build-season.ts,
// end-season.ts, ...): tier position ascending, then division groupNumber
// ascending within a tier. Zero dependencies -- plain data in, plain data out.

export interface LadderDivisionInput {
  id: string;
  name: string;
  // Parent tier's display name, e.g. "Legendary", "Common".
  tierName: string;
  // Parent tier's position -- lower sorts first (1 = top tier).
  tierPosition: number;
  // This division's position within its tier -- lower sorts first (1 =
  // closest to the tier above). Matches the Division.groupNumber column.
  groupNumber: number;
  // Hand-set by the organiser; passed straight through, never derived.
  promote: number;
  relegate: number;
}

export interface LadderNeighbor {
  id: string;
  name: string;
}

export interface LadderRung {
  id: string;
  name: string;
  tierName: string;
  tierPosition: number;
  promote: number;
  relegate: number;
  // The division directly above/below this one on the WHOLE ladder (across
  // tier boundaries too) -- null at the very top/bottom of the ladder.
  above: LadderNeighbor | null;
  below: LadderNeighbor | null;
  // 1-based position from the top of the whole ladder, and the ladder's
  // total size -- e.g. rung 3 of 9.
  rung: number;
  total: number;
  // Pre-formatted "<rung> of <total>" for direct display.
  ladderPosition: string;
}

// Deterministic sort key: tier position asc, then group number asc, then id
// asc as a final tiebreak so the result never depends on input order even
// when two divisions somehow share a (tierPosition, groupNumber) pair.
function sortKey(d: LadderDivisionInput): [number, number, string] {
  return [d.tierPosition, d.groupNumber, d.id];
}

function compareDivisions(a: LadderDivisionInput, b: LadderDivisionInput): number {
  const [aTier, aGroup, aId] = sortKey(a);
  const [bTier, bGroup, bId] = sortKey(b);
  if (aTier !== bTier) return aTier - bTier;
  if (aGroup !== bGroup) return aGroup - bGroup;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

// Orders every division onto the one ladder, top to bottom, and attaches
// each rung's neighbors. Pure + total: never mutates the input, and the
// output order depends only on (tierPosition, groupNumber, id) -- never on
// the order divisions were passed in.
export function buildLadder(divisions: LadderDivisionInput[]): LadderRung[] {
  const ordered = [...divisions].sort(compareDivisions);
  const total = ordered.length;
  return ordered.map((d, i) => {
    const prev = i > 0 ? ordered[i - 1]! : null;
    const next = i < total - 1 ? ordered[i + 1]! : null;
    return {
      id: d.id,
      name: d.name,
      tierName: d.tierName,
      tierPosition: d.tierPosition,
      promote: d.promote,
      relegate: d.relegate,
      above: prev ? { id: prev.id, name: prev.name } : null,
      below: next ? { id: next.id, name: next.name } : null,
      rung: i + 1,
      total,
      ladderPosition: `${i + 1} of ${total}`,
    };
  });
}

// Name of the division this rung's top finishers promote into -- null at
// the very top of the ladder (nothing above to promote to).
export function promotionTarget(rung: LadderRung): string | null {
  return rung.above?.name ?? null;
}

// Name of the division this rung's bottom finishers relegate into -- null
// at the very bottom of the ladder (nothing below to relegate to).
export function relegationTarget(rung: LadderRung): string | null {
  return rung.below?.name ?? null;
}
