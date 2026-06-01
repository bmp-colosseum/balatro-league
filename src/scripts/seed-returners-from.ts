// Seed-returners-from: open a new signup round prefilled with players
// from a previously-ENDED season, plus an optional batch of brand-new
// signups. Use this in the multi-season test loop where you want season
// N+1's build flow to react to REAL season N standings (not the
// fabricated prior season seed-test-league creates).
//
// Optional --skip-rate randomly drops some returners from the new
// round, simulating churn / players sitting one out — same shape as
// the "gap" scenario in seed-test-league.
//
// Usage:
//   npm run seed:returners-from -- --from <prevSeasonId>
//   npm run seed:returners-from -- --from <id> --new 20
//   npm run seed:returners-from -- --from <id> --skip-rate 0.15
//   npm run seed:returners-from -- --from <id> --new 20 --skip-rate 0.15 --seed 7

import { prisma } from "../db.js";

interface Args {
  fromSeasonId: string;
  newSignups: number;
  skipRate: number;
  seed: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string | null): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  const fromSeasonId = get("--from", null);
  if (!fromSeasonId) {
    console.error("--from <prevSeasonId> is required");
    process.exit(1);
  }
  return {
    fromSeasonId,
    newSignups: Number(get("--new", "0")) || 0,
    skipRate: Number(get("--skip-rate", "0")) || 0,
    seed: Number(get("--seed", "11")) || 11,
  };
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

// Same BMP-style MMR distribution as seed-test-league. Brand-new signups
// only — returners' MMR carries over via their existing PlayerMmrSnapshot.
function sampleMmr(rand: () => number): number {
  const r = rand();
  if (r < 0.50) return Math.floor(80 + rand() * 170);
  if (r < 0.75) return Math.floor(250 + rand() * 70);
  if (r < 0.90) return Math.floor(320 + rand() * 140);
  if (r < 0.97) return Math.floor(460 + rand() * 160);
  return Math.floor(620 + rand() * 200);
}

function mmrToTier(mmr: number): string {
  if (mmr < 250) return "Stone";
  if (mmr < 320) return "Steel";
  if (mmr < 460) return "Gold";
  if (mmr < 620) return "Lucky";
  return "Glass";
}

const ADJS = ["Lucky", "Wild", "Mystic", "Rapid", "Stoic", "Bold", "Cosmic", "Quiet", "Vivid", "Sly"];
const NOUNS = ["Joker", "Deck", "Stake", "Hand", "Suit", "Chip", "Mult", "Glass", "Foil", "Holo"];
function fakeName(rand: () => number, n: number): string {
  const adj = ADJS[Math.floor(rand() * ADJS.length)] ?? "Test";
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)] ?? "Player";
  return `${adj}${noun}${String(n).padStart(3, "0")}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rand = rng(args.seed);

  const prevSeason = await prisma.season.findUnique({
    where: { id: args.fromSeasonId },
    include: {
      divisions: {
        include: {
          members: {
            where: { status: "ACTIVE" },
            include: { player: true },
          },
        },
      },
    },
  });
  if (!prevSeason) {
    console.error(`Season ${args.fromSeasonId} not found.`);
    process.exit(1);
  }
  if (!prevSeason.endedAt) {
    console.warn(
      `Warning: season "${prevSeason.name}" hasn't been ended yet (endedAt is null). ` +
        `The build flow uses endedAt to identify "prior" data — you probably want to End it first.`,
    );
  }

  // Collect returning players from the prior season, applying skipRate.
  const returners: { discordId: string; displayName: string }[] = [];
  for (const div of prevSeason.divisions) {
    for (const member of div.members) {
      if (args.skipRate > 0 && rand() < args.skipRate) continue;
      returners.push({
        discordId: member.player.discordId,
        displayName: member.player.displayName,
      });
    }
  }

  const roundName = `Returners from ${prevSeason.name} (${new Date().toISOString().slice(0, 16)})`;
  const round = await prisma.signupRound.create({
    data: {
      name: roundName,
      guildId: "tl-test-guild",
      channelId: "tl-test-channel",
      messageId: "pending",
      status: "CLOSED", // ready to build right away
      closedAt: new Date(),
    },
  });

  // Update each returner's current MMR snapshot (drift from their prior
  // value if they have one, else sample fresh) so the build UI's "MMR
  // signal" column has fresh data — mirrors what the live signup-close
  // capture would do.
  for (const r of returners) {
    await prisma.signup.create({
      data: {
        roundId: round.id,
        discordId: r.discordId,
        displayName: r.displayName,
        signedUpAt: new Date(),
      },
    });
    // Find their most recent ranked snapshot (any season) so we can
    // drift from it. Falls back to a fresh sample for players that
    // never had one captured.
    const last = await prisma.playerMmrSnapshot.findFirst({
      where: { discordId: r.discordId },
      orderBy: { capturedAt: "desc" },
    });
    const baseMmr = last?.rankedMmr ?? sampleMmr(rand);
    const driftedMmr = Math.max(50, Math.floor(baseMmr + (rand() - 0.5) * 80));
    await prisma.playerMmrSnapshot.create({
      data: {
        discordId: r.discordId,
        seasonId: null, // pre-build "current" snapshot
        rankedMmr: driftedMmr,
        rankedTier: mmrToTier(driftedMmr),
        totalGames: 50 + Math.floor(driftedMmr / 10),
        winRatePct: Math.max(20, Math.min(80, 40 + Math.floor((driftedMmr - 200) / 12))),
      },
    });
  }

  // Brand-new signups, tagged with a tl-newN- prefix so the existing
  // resetTestLeagueData() helper still picks them up.
  for (let i = 1; i <= args.newSignups; i++) {
    const n = i;
    const discordId = `tl-newN-${round.id.slice(-6)}-${String(n).padStart(3, "0")}`;
    const displayName = fakeName(rand, 500 + n);
    await prisma.signup.create({
      data: {
        roundId: round.id,
        discordId,
        displayName,
        signedUpAt: new Date(),
      },
    });
    // 15% of new signups have no balatromp account, same as test-league fresh.
    if (rand() >= 0.15) {
      const mmr = sampleMmr(rand);
      await prisma.playerMmrSnapshot.create({
        data: {
          discordId,
          seasonId: null,
          rankedMmr: mmr,
          rankedTier: mmrToTier(mmr),
          totalGames: 50 + Math.floor(mmr / 10),
          winRatePct: Math.max(20, Math.min(80, 40 + Math.floor((mmr - 200) / 12))),
        },
      });
    }
  }

  console.log(`\n✓ Seeded ${returners.length} returners + ${args.newSignups} new signups.`);
  if (args.skipRate > 0) {
    console.log(`  (skip-rate ${args.skipRate}: some season-${prevSeason.name} players sat this one out)`);
  }
  console.log(`\nNext: /admin/signups/${round.id}/build`);
  await prisma.$disconnect();
}

await main();
