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
}
export interface RookieInput {
  discordId: string;
  displayName: string;
  mmr: number;
}

// UP-moves can take anyone — overflow may push the strongest up (Owen allows it;
// it doesn't lower anyone's floor). Prefer a rookie; else the best-standing
// returner.
function popUp(members: PlacementMember[]): PlacementMember {
  const rookies = members.filter((m) => m.isRookie);
  if (rookies.length) {
    let best = rookies[0]!;
    for (const m of rookies) if (m.mmr > best.mmr) best = m;
    members.splice(members.indexOf(best), 1);
    return best;
  }
  const rank = (m: PlacementMember) => m.standing?.rank ?? Number.POSITIVE_INFINITY;
  let best = members[0]!;
  for (const m of members) if (rank(m) < rank(best)) best = m;
  members.splice(members.indexOf(best), 1);
  return best;
}

// DOWN-moves can ONLY take rookies — THE FLOOR (Owen's "minimal rank"): a
// returner cannot be dropped below their division except by relegation, never by
// the overflow balancer. Returns null when there's no rookie to spare (then the
// caller pushes someone up instead, which the floor permits).
function popDown(members: PlacementMember[]): PlacementMember | null {
  const rookies = members.filter((m) => m.isRookie);
  if (!rookies.length) return null;
  let best = rookies[0]!;
  for (const m of rookies) if (m.mmr < best.mmr) best = m;
  members.splice(members.indexOf(best), 1);
  return best;
}

export function buildOwenPlacement(
  divisions: { tierName: string; name: string }[],
  returners: ReturnerInput[],
  rookies: RookieInput[],
  targetSize: number,
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
    });
  }

  // 3. Overflow: shed over-full divisions toward available space. target =
  //    ceil(total / n) guarantees capacity ≥ total, so this converges.
  const hasSpace = (i: number) => i >= 0 && i < n && divs[i]!.members.length < targetSize;
  const spaceBelowSomewhere = (i: number) => divs.slice(i + 1).some((d) => d.members.length < targetSize);
  let guard = 0;
  while (guard++ < 10000) {
    const i = divs.findIndex((d) => d.members.length > targetSize);
    if (i < 0) break;
    // Prefer the immediately-open neighbour. Up takes anyone; DOWN only a rookie
    // (the floor). If down is needed but only returners remain, push someone up
    // instead — the floor forbids dropping them, and up-room frees this division.
    if (hasSpace(i - 1)) {
      divs[i - 1]!.members.push(popUp(divs[i]!.members));
    } else if (hasSpace(i + 1) || (i < n - 1 && spaceBelowSomewhere(i))) {
      const m = popDown(divs[i]!.members);
      if (m) divs[i + 1]!.members.push(m);
      else if (i > 0) divs[i - 1]!.members.push(popUp(divs[i]!.members));
      else break;
    } else if (i > 0) {
      divs[i - 1]!.members.push(popUp(divs[i]!.members));
    } else {
      break;
    }
  }

  return divs;
}
