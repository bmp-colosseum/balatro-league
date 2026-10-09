// Pure core for /hall-of-fame's "trophy shelf" (v2 design). No I/O, no Prisma,
// no React -- just the one decision this page needs that is worth a unit
// test: how many overall titles has a given champion won, counting every
// season in the Hall of Fame's own data (not the per-division "prior titles"
// admin-winners.ts computes -- that one tracks EVERY division's rank-1
// finishes; a Hall of Fame champion is, by construction, always the winner
// of the top division, so counting their appearances across loadHallOfFame's
// season list IS their career title count here).

// Minimal shape titleCounts needs -- callers pass the real HofChampion
// (web/lib/loaders/hall-of-fame.ts), but the function only reads playerId,
// so it stays decoupled from that module's larger type.
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
