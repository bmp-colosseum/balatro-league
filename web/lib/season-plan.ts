// Pure season-planning math — NO prisma, NO server-only imports — so it can run
// in both the real build (web/lib/build-season.ts) and live in the browser for
// the dry-run placement sandbox. Given ranked players + a tier shape it returns
// which players land in which division, with zero side effects.

export interface TierConfig {
  name: string;
  divisionCount: number;
}

// Owen's fixed ladder: Legendary + Rare/Uncommon/Common, where each rarity has
// 5 divisions normally, 4 below 96 signups, 3 below 78. Total divisions drive
// the per-division size (~ceil(signups / #divisions)) via planByRating.
export function owenLadder(signupCount: number): TierConfig[] {
  const per = signupCount >= 96 ? 5 : signupCount >= 78 ? 4 : 3;
  return [
    { name: "Legendary", divisionCount: 1 },
    { name: "Rare", divisionCount: per },
    { name: "Uncommon", divisionCount: per },
    { name: "Common", divisionCount: per },
  ];
}

export function parseTierConfig(json: string): TierConfig[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => ({
        name: String(e?.name ?? "").trim(),
        divisionCount: Math.max(1, Math.min(50, Math.floor(Number(e?.divisionCount)))) || 1,
      }))
      .filter((t) => t.name.length > 0);
  } catch {
    return [];
  }
}

// Distribute ranked players top-down into tiers, filling each division
// in rank order. Rare 1 takes the top 5 Rare ranks, Rare 2 the next 5,
// ..., Rare 6 the bottom 5. (Previously snake-drafted to balance skill
// across same-tier divisions, but that made entering rank diverge wildly
// from ending rank since the per-division end-season recompute reranks
// every player to their division's rank slot.)
//
// Filling strategy: every division ends up with either `base` or `base+1`
// players, where base = floor(N / totalDivs). Extras (the `N mod totalDivs`
// players who push some divisions to base+1) go to UPPER tiers first —
// Legendary/Rare fill before Common takes leftovers. No special case for
// the top tier — it's just another tier in the math.
export function planByRating(
  ranked: Array<{ id: string; discordId: string; displayName: string; rating: number | null }>,
  tiers: TierConfig[],
  targetGroupSize: number,
): Array<{ tier: TierConfig; position: number; divisions: string[][] /* signup discordIds per division */ }> {
  void targetGroupSize; // kept on signature for caller compat; new alg derives sizes dynamically
  // Sort by rating ASC (rating = rank, 1 = best player). null
  // (unrated) sorts AFTER ranked players via Infinity sentinel.
  const sorted = [...ranked].sort((a, b) => {
    const ra = a.rating ?? Number.POSITIVE_INFINITY;
    const rb = b.rating ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName);
  });

  if (sorted.length === 0 || tiers.length === 0) {
    return tiers.map((tier, i) => ({
      tier,
      position: i + 1,
      divisions: Array.from({ length: Math.max(1, tier.divisionCount) }, () => []),
    }));
  }

  const totalDivs = tiers.reduce((sum, t) => sum + Math.max(1, t.divisionCount), 0);
  const base = totalDivs === 0 ? 0 : Math.floor(sorted.length / totalDivs);
  let extras = totalDivs === 0 ? 0 : sorted.length - base * totalDivs;
  const divisionSizes: number[][] = tiers.map((t) => {
    const numDivs = Math.max(1, t.divisionCount);
    return Array.from({ length: numDivs }, () => {
      const extra = extras > 0 ? 1 : 0;
      if (extras > 0) extras--;
      return base + extra;
    });
  });

  const plan: ReturnType<typeof planByRating> = [];
  let cursor = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const numDivs = Math.max(1, tier.divisionCount);
    const sizes = divisionSizes[i]!;

    // Sequential fill: division 0 takes the next `sizes[0]` players in
    // rank order, division 1 takes the next `sizes[1]`, etc. So Rare 1
    // gets the strongest Rare players, Rare 6 gets the weakest.
    const divisions: string[][] = [];
    for (let d = 0; d < numDivs; d++) {
      const size = sizes[d]!;
      const slice = sorted.slice(cursor, cursor + size).map((p) => p.discordId);
      cursor += size;
      divisions.push(slice);
    }

    plan.push({ tier, position: i + 1, divisions });
  }
  return plan;
}
