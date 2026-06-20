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

// Configurable placement rules (all optional; defaults reproduce Owen's rule).
export interface PlacementOpts {
  // Top division (Legendary) fixed size — overflow keeps division 0 at this cap.
  topTarget?: number;
  // Rare 1↔2 and Rare 2↔3 use asymmetric 1-up / 2-down (else count-based).
  tightenTopTiers?: boolean;
  // Count-based boundaries swap `bigSwap` when BOTH divisions have ≥ swapThreshold
  // finishers, else `baseSwap`.
  swapThreshold?: number;
  baseSwap?: number;
  bigSwap?: number;
}

interface TierGroup { tier: string; group: number }
// tier + group (1-based) per division index, e.g. {Legendary,1}, {Rare,1}, …
function computeGroups(divisions: { tierName: string }[]): TierGroup[] {
  const groupOf: TierGroup[] = [];
  const seen: Record<string, number> = {};
  for (const d of divisions) {
    seen[d.tierName] = (seen[d.tierName] ?? 0) + 1;
    groupOf.push({ tier: d.tierName, group: seen[d.tierName]! });
  }
  return groupOf;
}
// Pairwise boundary (up = promoted lower→upper, down = relegated upper→lower) for
// the boundary between upper index i and lower index i+1. `counts` = finishers (or
// current members, for display) per division — only consulted for count-based tiers.
function boundaryAt(
  i: number,
  groupOf: TierGroup[],
  counts: number[],
  opts: { tightenTopTiers: boolean; swapThreshold: number; baseSwap: number; bigSwap: number },
): { up: number; down: number } {
  const upper = groupOf[i]!;
  if (upper.tier === "Legendary") return { up: 1, down: 1 };
  if (opts.tightenTopTiers && upper.tier === "Rare" && (upper.group === 1 || upper.group === 2)) {
    return { up: 1, down: 2 };
  }
  const k = (counts[i] ?? 0) >= opts.swapThreshold && (counts[i + 1] ?? 0) >= opts.swapThreshold ? opts.bigSwap : opts.baseSwap;
  return { up: k, down: k };
}

// Per-division promote/relegate counts under the SAME rule the build uses — the
// single source of truth for "how many move", so the standings display can never
// drift from the actual placement. `sizes` = members (or finishers) per division
// in ladder order. Top division never promotes; bottom never relegates.
export function divisionMovement(
  divisions: { tierName: string }[],
  sizes: number[],
  opts: PlacementOpts = {},
): { promote: number; relegate: number }[] {
  const { tightenTopTiers = true, swapThreshold = 8, baseSwap = 1, bigSwap = 2 } = opts;
  const groupOf = computeGroups(divisions);
  const o = { tightenTopTiers, swapThreshold, baseSwap, bigSwap };
  const n = divisions.length;
  return divisions.map((_, i) => ({
    promote: i >= 1 ? boundaryAt(i - 1, groupOf, sizes, o).up : 0,
    relegate: i <= n - 2 ? boundaryAt(i, groupOf, sizes, o).down : 0,
  }));
}

export function buildOwenPlacement(
  divisions: { tierName: string; name: string }[],
  returners: ReturnerInput[],
  rookies: RookieInput[],
  targetSize: number,
  opts: PlacementOpts = {},
): PlacementDivision[] {
  const { topTarget, tightenTopTiers = true, swapThreshold = 8, baseSwap = 1, bigSwap = 2 } = opts;
  const n = divisions.length;
  const divs: PlacementDivision[] = divisions.map((d) => ({ tierName: d.tierName, name: d.name, members: [] }));

  // 1. Returners start in their finish division, then PAIRWISE boundary
  //    promotion/relegation (Owen's rule):
  //    - Count-based boundaries (Rare 3↔Rare 4 and below): swap K, where K = 2
  //      when BOTH divisions have ≥ 8 finishers, else 1 (symmetric).
  //    - Top boundaries tighten the elite: Legendary↔Rare 1 = 1 up / 1 down;
  //      Rare 1↔Rare 2 and Rare 2↔Rare 3 = 1 up / 2 down.
  //    Promotions = the top of the LOWER division by finish; relegations = the
  //    bottom of the UPPER division by finish. Selection uses original finish
  //    membership, so no cascades.
  const finishers: ReturnerInput[][] = Array.from({ length: n }, () => []);
  for (const r of returners) {
    const di = Math.max(0, Math.min(n - 1, r.divIndex));
    finishers[di]!.push(r);
  }
  for (const arr of finishers) arr.sort((a, b) => a.standingRank - b.standingRank); // best (rank 1) first
  const counts = finishers.map((a) => a.length);

  // Same pairwise boundary rule the display reads via divisionMovement().
  const groupOf = computeGroups(divisions);
  const boundaryK = (i: number) => boundaryAt(i, groupOf, counts, { tightenTopTiers, swapThreshold, baseSwap, bigSwap });

  // Each division's top `up` promote (via the boundary above), bottom `down`
  // relegate (via the boundary below); capped so the same finisher isn't both.
  const targetOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const arr = finishers[i]!;
    const size = arr.length;
    const up = Math.min(size, i >= 1 ? boundaryK(i - 1).up : 0);
    let down = i <= n - 2 ? boundaryK(i).down : 0;
    if (up + down > size) down = Math.max(0, size - up);
    arr.forEach((r) => targetOf.set(r.discordId, i)); // default: hold finish
    for (let k = 0; k < up; k++) targetOf.set(arr[k]!.discordId, i - 1); // promote
    for (let k = 0; k < down; k++) targetOf.set(arr[size - 1 - k]!.discordId, i + 1); // relegate
  }

  for (const r of returners) {
    const target = targetOf.get(r.discordId) ?? Math.max(0, Math.min(n - 1, r.divIndex));
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
  //    EMPTY divisions are null (skipped) — otherwise their avg-of-0 would suck
  //    weak rookies up into an empty top division. A rookie below every populated
  //    division's average falls to the bottom.
  const returnerAvg = divs.map((d) => (d.members.length ? d.members.reduce((a, m) => a + m.mmr, 0) / d.members.length : null));
  for (const rk of rookies) {
    let bestIdx = n - 1;
    let bestAvg = -Infinity;
    for (let i = 0; i < n; i++) {
      const avg = returnerAvg[i];
      if (avg != null && avg <= rk.mmr && avg > bestAvg) {
        bestAvg = avg;
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
