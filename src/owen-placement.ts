// Owen's season-build placement, as a pure function.
//
// Rules (from his proposal):
//   1. Returners hold their current division, EXCEPT promotion/relegation: the
//      top K of a division move up one, the bottom K move down one. K = 2 when
//      the division has ≥ 8 players, else 1.
//   2. Rookies (no league history) drop into the division whose AVERAGE MMR is
//      the greatest value ≤ their MMR (greatest-lower-bound); if none qualify,
//      the lowest division.
//   3. Overflow: no division may exceed the target size (ceil(total / #divs)).
//      An over-full division sheds toward open space, cascading until balanced.
//      THE FLOOR (Owen's "minimal rank"): downward overflow can only move
//      ROOKIES — a returner is never dropped below their division by the
//      balancer, only by relegation. Upward overflow can move anyone.
//
// Crucially, returner PLACEMENT is by division + standing, NOT by raw MMR — so a
// strong league player with a weak BMP number keeps their spot. MMR is only used
// for rookie slotting + overflow tie-breaks, and every player is on ONE scale.

export interface PlacementMember {
  discordId: string;
  displayName: string;
  mmr: number;
  isRookie: boolean;
  standing: { rank: number; record: string } | null;
  // Returner's ORIGINAL division index (on this ladder) before promotion/
  // relegation/overflow — lets the UI show "↑ from Rare 1". Null for rookies.
  fromIndex: number | null;
  // BMP ranked MMR, carried purely for display/sanity-check (not used by the
  // algorithm). Null if no BMP data.
  bmp: number | null;
}
export interface PlacementDivision {
  tierName: string;
  name: string;
  members: PlacementMember[];
}

export interface ReturnerInput {
  discordId: string;
  displayName: string;
  mmr: number;
  divIndex: number; // index in `divisions`, 0 = top (Legendary)
  standingRank: number; // 1 = top of their current division
  divSize: number; // how many are in their current division
  standing: { rank: number; record: string } | null;
  bmp?: number | null;
}
export interface RookieInput {
  discordId: string;
  displayName: string;
  mmr: number;
  bmp?: number | null;
}

// Overflow moves ONLY rookies — returners are locked to their finish division
// (+ promotion/relegation), never shuffled by the size-balancer. `preferHigh` =
// moving up (take the strongest rookie) vs down (the weakest). Null if the
// division has no rookie to spare.
function popRookie(members: PlacementMember[], preferHigh: boolean): PlacementMember | null {
  const rookies = members.filter((m) => m.isRookie);
  if (!rookies.length) return null;
  let best = rookies[0]!;
  for (const m of rookies) if (preferHigh ? m.mmr > best.mmr : m.mmr < best.mmr) best = m;
  members.splice(members.indexOf(best), 1);
  return best;
}

export function buildOwenPlacement(
  divisions: { tierName: string; name: string }[],
  returners: ReturnerInput[],
  rookies: RookieInput[],
  targetSize: number,
  // The top division (Legendary) is a fixed size — an elite round-robin of this
  // many. When set, overflow keeps division 0 at this cap instead of targetSize.
  topTarget?: number,
): PlacementDivision[] {
  const n = divisions.length;
  const divs: PlacementDivision[] = divisions.map((d) => ({ tierName: d.tierName, name: d.name, members: [] }));

  // 1. Returners: hold division, apply promotion/relegation.
  for (const r of returners) {
    const k = r.divSize >= 8 ? 2 : 1;
    let target = r.divIndex;
    if (r.standingRank <= k) target = Math.max(0, target - 1); // promote up
    else if (r.standingRank > r.divSize - k) target = Math.min(n - 1, target + 1); // relegate down
    divs[target]!.members.push({
      discordId: r.discordId,
      displayName: r.displayName,
      mmr: r.mmr,
      isRookie: false,
      standing: r.standing,
      fromIndex: r.divIndex,
      bmp: r.bmp ?? null,
    });
  }

  // 2. Rookies: greatest-lower-bound on the returner averages (fixed snapshot).
  const returnerAvg = divs.map((d) => (d.members.length ? d.members.reduce((a, m) => a + m.mmr, 0) / d.members.length : 0));
  for (const rk of rookies) {
    let bestIdx = n - 1;
    let bestAvg = -Infinity;
    for (let i = 0; i < n; i++) {
      if (returnerAvg[i]! <= rk.mmr && returnerAvg[i]! > bestAvg) {
        bestAvg = returnerAvg[i]!;
        bestIdx = i;
      }
    }
    divs[bestIdx]!.members.push({
      discordId: rk.discordId,
      displayName: rk.displayName,
      mmr: rk.mmr,
      isRookie: true,
      standing: null,
      fromIndex: null,
      bmp: rk.bmp ?? null,
    });
  }

  // 3. Overflow: balance sizes by moving ONLY ROOKIES into open neighbours
  //    (strongest up, weakest down). Returners stay put — a division over-full
  //    with only returners is left bigger rather than shuffling earned spots.
  const targetAt = (i: number) => (i === 0 && topTarget != null ? topTarget : targetSize);
  const hasSpace = (i: number) => i >= 0 && i < n && divs[i]!.members.length < targetAt(i);
  const spaceBelowSomewhere = (i: number) => {
    for (let j = i + 1; j < n; j++) if (divs[j]!.members.length < targetAt(j)) return true;
    return false;
  };
  let guard = 0;
  while (guard++ < 10000) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (divs[i]!.members.length <= targetAt(i)) continue;
      if (!divs[i]!.members.some((m) => m.isRookie)) continue; // only returners → leave it
      let m: PlacementMember | null = null;
      if (hasSpace(i - 1)) m = popRookie(divs[i]!.members, true); // strongest rookie up
      else if ((hasSpace(i + 1) || spaceBelowSomewhere(i)) && i < n - 1) {
        const r = popRookie(divs[i]!.members, false); // weakest rookie down
        if (r) { divs[i + 1]!.members.push(r); moved = true; break; }
      } else if (i > 0) m = popRookie(divs[i]!.members, true);
      if (m) { divs[i - 1]!.members.push(m); moved = true; break; }
    }
    if (!moved) break;
  }

  // 4. Hard-cap the top division (Legendary) at topTarget. It's a fixed elite
  //    size, so finishing outside the top `topTarget` means relegation to
  //    division 1 — the same boundary every division has, applied to the cap.
  //    Relegate the WEAKEST first: rookies (no finish) → players who came from a
  //    LOWER division (promotees before holders) → worse finish → lower MMR.
  if (topTarget != null && n > 1) {
    const weaker = (a: PlacementMember, b: PlacementMember): boolean => {
      if (a.isRookie !== b.isRookie) return a.isRookie; // rookies are weakest
      if (a.isRookie && b.isRookie) return a.mmr < b.mmr;
      const af = a.fromIndex ?? 0;
      const bf = b.fromIndex ?? 0;
      if (af !== bf) return af > bf; // came from a lower division → weaker
      const ar = a.standing?.rank ?? Infinity;
      const br = b.standing?.rank ?? Infinity;
      if (ar !== br) return ar > br; // worse finish → weaker
      return a.mmr < b.mmr;
    };
    while (divs[0]!.members.length > topTarget) {
      const m = divs[0]!.members;
      let worst = 0;
      for (let i = 1; i < m.length; i++) if (weaker(m[i]!, m[worst]!)) worst = i;
      const [moved] = m.splice(worst, 1);
      divs[1]!.members.push(moved!);
    }
  }

  return divs;
}
