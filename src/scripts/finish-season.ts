// Finish-season: take an existing season and auto-confirm every pending
// pairing with a random result. Use this in test flows where you've gone
// through signup → build but don't want to click through every match
// before hitting End on /admin/seasons/<id>.
//
// Skips pairings that are already CONFIRMED, only touches PENDING /
// DISPUTED rows. Does NOT mark the season ended — admin still hits the
// End button (or runs the next script) so you can verify the UI.
//
// Usage:
//   npm run finish:season -- --season <seasonId>
//   npm run finish:season -- --season <seasonId> --seed 42

import { prisma } from "../db.js";
import { PgBoss } from "pg-boss";
import { env } from "../env.js";
import { gamesFromResult, type PairingResult } from "../scoring.js";
import { recomputeDivisionStandings } from "../standings-cache.js";

// The script can't call initQueue() — that registers workers in this
// process which would compete with the bot service for jobs (and
// abandon them when the script exits). Instead, spin up a send-only
// pg-boss client and let the bot's workers drain the queue.
let sendOnlyBoss: PgBoss | null = null;
async function getSendOnlyBoss(): Promise<PgBoss> {
  if (sendOnlyBoss) return sendOnlyBoss;
  sendOnlyBoss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" });
  await sendOnlyBoss.start();
  return sendOnlyBoss;
}
async function enqueueAnnounceResult(pairingId: string): Promise<void> {
  const boss = await getSendOnlyBoss();
  await boss.send("notify.announce-result", { pairingId }, { retryLimit: 2, retryBackoff: true });
}

interface Args {
  seasonId: string;
  seed: number;
  announce: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string | null): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  const seasonId = get("--season", null);
  if (!seasonId) {
    console.error("--season <id> is required");
    process.exit(1);
  }
  const seedRaw = get("--seed", "42");
  // --announce opts into posting each pairing to the results channel.
  // Off by default: a 100-pairing seed run would spam the channel and
  // hit Discord rate limits. Useful when verifying the results
  // destination is wired up correctly (try with a small division).
  const announce = argv.includes("--announce");
  return { seasonId, seed: Number(seedRaw) || 42, announce };
}

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

// Same distribution as sim-season — 40% 2-0, 20% 1-1, 40% 0-2.
function randomResult(rand: () => number): PairingResult {
  const r = rand();
  if (r < 0.4) return "2-0";
  if (r < 0.6) return "1-1";
  return "0-2";
}

async function main(): Promise<void> {
  const { seasonId, seed, announce } = parseArgs();
  const rand = rng(seed);

  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) {
    console.error(`Season ${seasonId} not found.`);
    process.exit(1);
  }
  console.log(`Filling pending pairings for season "${season.name}" (${season.id})`);

  // Make sure every expected round-robin pairing exists. Build expects
  // the admin to play matches which writes Pairing rows on demand — if
  // the test flow skipped that, there might not BE any pairings yet.
  // Materialize the full round-robin matrix first.
  const divisions = await prisma.division.findMany({
    where: { seasonId },
    include: { members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
  });

  let created = 0;
  let confirmed = 0;
  for (const div of divisions) {
    const playerIds = div.members.map((m) => m.playerId).sort();
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const [aId, bId] = [playerIds[i]!, playerIds[j]!];
        const existing = await prisma.pairing.findUnique({
          where: { divisionId_playerAId_playerBId: { divisionId: div.id, playerAId: aId, playerBId: bId } },
        });
        const result = randomResult(rand);
        const { a: gA, b: gB } = gamesFromResult(result);
        if (!existing) {
          const created2 = await prisma.pairing.create({
            data: {
              divisionId: div.id,
              playerAId: aId,
              playerBId: bId,
              gamesWonA: gA,
              gamesWonB: gB,
              status: "CONFIRMED",
              reportedAt: new Date(),
              confirmedAt: new Date(),
            },
          });
          created++;
          if (announce) {
            await enqueueAnnounceResult(created2.id).catch((err) => console.warn("[finish:season] announce failed:", err));
          }
        } else if (existing.status !== "CONFIRMED") {
          await prisma.pairing.update({
            where: { id: existing.id },
            data: {
              gamesWonA: gA,
              gamesWonB: gB,
              status: "CONFIRMED",
              reportedAt: existing.reportedAt ?? new Date(),
              confirmedAt: new Date(),
              // Clear any dispute state the test flow may have left behind.
              disputedById: null,
              disputeProposedGamesWonA: null,
              disputeProposedGamesWonB: null,
              disputeReason: null,
              disputedAt: null,
            },
          });
          confirmed++;
          if (announce) {
            await enqueueAnnounceResult(existing.id).catch((err) => console.warn("[finish:season] announce failed:", err));
          }
        }
      }
    }
  }

  // Refresh the materialized standings so /standings and the admin
  // pages reflect the new results without waiting for the next click.
  for (const div of divisions) {
    await recomputeDivisionStandings(div.id).catch(() => {});
  }

  console.log(`Done. ${created} created, ${confirmed} previously-pending confirmed across ${divisions.length} divisions.`);
  if (announce) {
    console.log(`Announces enqueued — bot worker will drain them at ~1/sec into the configured results channel.`);
  }
  console.log(`Next: open /admin/seasons/${seasonId} and click End season.`);
  if (sendOnlyBoss) await sendOnlyBoss.stop({ graceful: true });
  await prisma.$disconnect();
}

await main();
