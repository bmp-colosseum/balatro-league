// One-off backfill: recompute PlayerMmrSnapshot.rankedTier from the stored
// rankedMmr + bmpSeason using the season-aware ladder.
//
// WHY: tiers used to be computed from one flat table with no season awareness,
// but balatromp's cutoffs shifted +300 at season 7 - so nearly every season-7
// snapshot was mislabelled (a 700-MMR season-7 player stored as "Glass" when
// they are only "Gold"). The MMR itself was always captured correctly, so this
// is a pure recomputation - no refetching balatromp, no rate limits.
//
// This is a THIN CALLER: all tier logic lives in ../balatro-ranks.ts (the shared
// port of the game's own ranks.ts). Nothing bespoke here.
//
// Usage:
//   npx tsx src/scripts/backfill-mmr-tiers.ts            # dry run (default)
//   npx tsx src/scripts/backfill-mmr-tiers.ts --apply    # actually write

import { prisma } from "../db.js";
import { enhancementTier } from "../balatro-ranks.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "[backfill] APPLY mode - will write" : "[backfill] DRY RUN - no writes (pass --apply to write)");

  const rows = await prisma.playerMmrSnapshot.findMany({
    where: { rankedMmr: { not: null } },
    select: { id: true, bmpSeason: true, rankedMmr: true, rankedTier: true },
  });
  console.log(`[backfill] ${rows.length} snapshot(s) with an MMR`);

  const bySeason = new Map<string, { checked: number; changed: number }>();
  const changes: Array<{ id: string; from: string | null; to: string }> = [];

  for (const r of rows) {
    if (r.rankedMmr == null) continue;
    const correct = enhancementTier(r.rankedMmr, r.bmpSeason);
    const key = r.bmpSeason ?? "(unset)";
    const acc = bySeason.get(key) ?? { checked: 0, changed: 0 };
    acc.checked++;
    if (r.rankedTier !== correct) {
      acc.changed++;
      changes.push({ id: r.id, from: r.rankedTier, to: correct });
    }
    bySeason.set(key, acc);
  }

  for (const [season, { checked, changed }] of [...bySeason.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    console.log(`[backfill] ${season}: ${changed}/${checked} would change`);
  }
  console.log(`[backfill] TOTAL to change: ${changes.length}`);

  if (!apply) {
    console.log("[backfill] dry run complete - nothing written");
    return;
  }

  // Group by target tier so we can do a handful of bulk updateMany calls instead
  // of one round trip per row.
  const byTier = new Map<string, string[]>();
  for (const c of changes) {
    const ids = byTier.get(c.to) ?? [];
    ids.push(c.id);
    byTier.set(c.to, ids);
  }
  let written = 0;
  for (const [tier, ids] of byTier) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = await prisma.playerMmrSnapshot.updateMany({
        where: { id: { in: chunk } },
        data: { rankedTier: tier },
      });
      written += res.count;
    }
    console.log(`[backfill] -> ${tier}: ${ids.length}`);
  }
  console.log(`[backfill] wrote ${written} row(s)`);
}

main()
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
