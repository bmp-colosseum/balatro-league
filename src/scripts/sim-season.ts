// Season simulator: spins up a self-contained mock season with fake players,
// plays every pairing with a deterministic RNG, prints final standings per division.
//
// Usage:
//   npm run sim:season -- [--divisions 4] [--players-per-div 5] [--seed 42] [--reset]
//
// --reset wipes any existing "sim-*" data first. Without it, re-running stacks on top.

import { Rarity, type Player } from "@prisma/client";
import { prisma } from "../db.js";
import { gamesFromResult, type PairingResult } from "../scoring.js";
import { computeStandings, formatStandingsTable } from "../standings.js";

interface Args {
  divisions: number;
  playersPerDiv: number;
  seed: number;
  reset: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  return {
    divisions: Number(get("--divisions", "4")),
    playersPerDiv: Number(get("--players-per-div", "5")),
    seed: Number(get("--seed", "42")),
    reset: argv.includes("--reset"),
  };
}

// Tiny seeded PRNG (mulberry32) so runs are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomResult(rand: () => number): PairingResult {
  const r = rand();
  if (r < 0.4) return "2-0";
  if (r < 0.6) return "1-1";
  return "0-2";
}

async function main() {
  const args = parseArgs();
  const rand = rng(args.seed);

  if (args.reset) {
    console.log("Resetting prior sim data...");
    await prisma.pairing.deleteMany({ where: { division: { season: { name: { startsWith: "Sim " } } } } });
    await prisma.divisionMember.deleteMany({ where: { division: { season: { name: { startsWith: "Sim " } } } } });
    await prisma.division.deleteMany({ where: { season: { name: { startsWith: "Sim " } } } });
    await prisma.season.deleteMany({ where: { name: { startsWith: "Sim " } } });
    await prisma.player.deleteMany({ where: { discordId: { startsWith: "sim-" } } });
  }

  const seasonName = `Sim ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`\nCreating season "${seasonName}" with ${args.divisions} divisions × ${args.playersPerDiv} players (seed ${args.seed})\n`);

  const season = await prisma.season.create({
    data: { name: seasonName, isActive: false }, // mark inactive so real /report doesn't see it
  });

  // Spread divisions across rarities for variety: first → Legendary, then Rare, Uncommon, Common
  const rarityOrder: Rarity[] = ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"];
  const groupCounter = new Map<Rarity, number>();

  for (let d = 0; d < args.divisions; d++) {
    const rarity = rarityOrder[Math.min(d, rarityOrder.length - 1)]!;
    const groupNumber = (groupCounter.get(rarity) ?? 0) + 1;
    groupCounter.set(rarity, groupNumber);
    const divisionName = rarity === "LEGENDARY" ? "Legendary" : `${titleCase(rarity)} ${groupNumber}`;

    const division = await prisma.division.create({
      data: { seasonId: season.id, rarity, groupNumber, name: divisionName },
    });

    const players: Player[] = [];
    for (let p = 0; p < args.playersPerDiv; p++) {
      const discordId = `sim-${season.id.slice(-6)}-d${d}-p${p}`;
      const displayName = `${divisionName.replace(" ", "")}P${p + 1}`;
      const player = await prisma.player.create({
        data: { discordId, displayName },
      });
      await prisma.divisionMember.create({
        data: { divisionId: division.id, playerId: player.id },
      });
      players.push(player);
    }

    // Round-robin: every unordered pair plays exactly once.
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const [playerAId, playerBId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const result = randomResult(rand);
        // gamesFromResult is from a's POV in the input; flip if we swapped order
        const fromA = result;
        const { a: gA, b: gB } =
          a.id === playerAId ? gamesFromResult(fromA) : flipGames(gamesFromResult(fromA));
        await prisma.pairing.create({
          data: {
            divisionId: division.id,
            playerAId,
            playerBId,
            gamesWonA: gA,
            gamesWonB: gB,
            status: "CONFIRMED",
            reportedAt: new Date(),
            confirmedAt: new Date(),
          },
        });
      }
    }

    const rows = computeStandings(
      players,
      await prisma.pairing.findMany({
        where: { divisionId: division.id },
        select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
      }),
    );
    console.log(formatStandingsTable(divisionName, rows));
    console.log("");
  }

  console.log(`Simulation complete. Season id: ${season.id}`);
  console.log(`(Marked inactive — won't interfere with your real /report flow.)`);

  await prisma.$disconnect();
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function flipGames(g: { a: number; b: number }): { a: number; b: number } {
  return { a: g.b, b: g.a };
}

await main();
