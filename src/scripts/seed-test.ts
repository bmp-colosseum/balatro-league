// Test seed: drops you and a friend into a single test division so /report has something to find.
//
// Usage:
//   tsx src/scripts/seed-test.ts <yourDiscordId> <opponentDiscordId> [yourName] [opponentName]
//
// Safe to re-run — it upserts and won't duplicate.

import { prisma } from "../db.js";
import { formatSeasonLabel } from "../format-season.js";

const [yourId, opponentId, yourName = "You", opponentName = "Opponent"] = process.argv.slice(2);

if (!yourId || !opponentId) {
  console.error(
    "Usage: tsx src/scripts/seed-test.ts <yourDiscordId> <opponentDiscordId> [yourName] [opponentName]",
  );
  process.exit(1);
}

// Use the normal next-number sequence on first create so the test
// season renders cleanly in admin. On re-runs the upsert hits the
// existing row by id and skips the number entirely (update path
// doesn't touch number).
const existing = await prisma.season.findUnique({ where: { id: "test-season" } });
const seasonNumber = existing?.number ?? ((await prisma.season.aggregate({ _max: { number: true } }))._max.number ?? 0) + 1;

const season = await prisma.season.upsert({
  where: { id: "test-season" },
  create: {
    id: "test-season",
    number: seasonNumber,
    subtitle: "Test",
    deadline: new Date("2026-06-13T18:00:00Z"),
    isActive: true,
  },
  update: { isActive: true },
});

// Per-season Tier: upsert a Common tier at position 1 (this test season has just one tier).
const tier = await prisma.tier.upsert({
  where: { seasonId_position: { seasonId: season.id, position: 1 } },
  create: { seasonId: season.id, position: 1, name: "Common" },
  update: {},
});

const division = await prisma.division.upsert({
  where: {
    seasonId_tierId_groupNumber: {
      seasonId: season.id,
      tierId: tier.id,
      groupNumber: 1,
    },
  },
  create: {
    seasonId: season.id,
    tierId: tier.id,
    groupNumber: 1,
    name: "Test Common 1",
  },
  update: {},
});

const me = await prisma.player.upsert({
  where: { discordId: yourId },
  create: { discordId: yourId, displayName: yourName },
  update: { displayName: yourName },
});

const opp = await prisma.player.upsert({
  where: { discordId: opponentId },
  create: { discordId: opponentId, displayName: opponentName },
  update: { displayName: opponentName },
});

for (const p of [me, opp]) {
  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId: division.id, playerId: p.id } },
    create: { divisionId: division.id, seasonId: season.id, playerId: p.id },
    update: {},
  });
}

console.log("Seeded test data:");
console.log(`  Season:   ${formatSeasonLabel(season)} (${season.id})`);
console.log(`  Division: ${division.name} (${division.id})`);
console.log(`  Players:  ${me.displayName} (${me.discordId}) vs ${opp.displayName} (${opp.discordId})`);
console.log("\nNow try `/report` in your Discord server.");

await prisma.$disconnect();
