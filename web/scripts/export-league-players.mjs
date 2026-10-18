// Export the league's verified name → Discord-ID map for Team Tour identity linking.
// Read-only. Writes apps/tour/league-players.csv, which apps/tour/scripts/
// export-players.mjs auto-fills from (exact-name match → auto-link; near matches →
// printed as suggestions). Keyed by BOTH displayName and username (same discordId)
// so a TT sheet name that's someone's @handle still matches.
//
//   node web/scripts/export-league-players.mjs
//
// Then in apps/tour: `npm run export:players` (auto-fills), fix leftovers in
// discord-map.csv, `npm run relink:discord -- --apply`.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Prisma 7 requires a driver adapter; same pool shape as lib/prisma-pool.ts.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 20000, idleTimeoutMillis: 10000 }),
});

const players = await prisma.player.findMany({ select: { displayName: true, username: true, discordId: true } });

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "apps", "tour", "league-players.csv");

const lines = ["name,discordId"];
const seen = new Set();
for (const p of players) {
  if (!p.discordId) continue;
  for (const name of [p.displayName, p.username]) {
    if (!name) continue;
    const key = `${name.toLowerCase()}|${p.discordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${name},${p.discordId}`);
  }
}

writeFileSync(out, lines.join("\n") + "\n");
console.log(`[export-league] ${players.length} league players → ${lines.length - 1} name rows`);
console.log(`[export-league] wrote ${out}`);
await prisma.$disconnect();
