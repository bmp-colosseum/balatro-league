// Pure core for /hall-of-fame's "trophy shelf" (v2 design). No I/O, no Prisma,
// no React -- just the one decision this page needs that is worth a unit
// test: how many titles has a given champion won, counting every entry in
// whatever champion list is passed in. The loader (web/lib/loaders/hall-of-fame.ts)
// calls this TWICE with two different subject lists, both drawn from the same
// Hall of Fame's ended seasons:
//   - LEAGUE titles (v1): one HofChampion per season (the top division's
//     winner only) -- HofChampion.titleCount.
//   - DIVISION titles (v2 trophy shelf): one HofDivisionChampion per division
//     per season (every tier, not just the top) -- HofDivisionChampion.titleCount,
//     which mirrors the "Nx <Tier> Winner" Discord roles. Distinct from the
//     per-division "prior titles" admin-winners.ts computes for the admin
//     winners page (same rank-1-across-seasons idea, different surface/shape).
// titleCounts itself doesn't know or care which list it's counting -- it's a
// plain tally over playerId, so both uses share this one well-tested function.

// Minimal shape titleCounts needs -- callers pass the real HofChampion or
// HofDivisionChampion (web/lib/loaders/hall-of-fame.ts), but the function only
// reads playerId, so it stays decoupled from either module's larger type.
export interface TitleCountSubject {
  readonly playerId: string;
}

// Map<playerId, title count> over every champion passed in. Order of the
// input has no effect on the result (a plain tally), and every count is
// >= 1 for any playerId present at all.
export function titleCounts(champions: readonly TitleCountSubject[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of champions) {
    out.set(c.playerId, (out.get(c.playerId) ?? 0) + 1);
  }
  return out;
}
