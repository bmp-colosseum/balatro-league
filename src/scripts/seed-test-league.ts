// Test-league seed: fabricates the data needed to demo the build-season
// flow with realistic input. Three scenarios cover the cases the admin
// actually has to handle:
//
//   fresh   — 100 brand-new signups, no league history. Only signal is
//             BMP MMR snapshot. Mirrors a first-ever league setup.
//   refresh — 80 returners (with prior league standings + prior MMR) +
//             20 new players. Mirrors season N+1 with normal churn.
//   gap     — refresh + 10 returners who skipped a season (their league
//             rank is from 2 seasons ago). Stress-tests the "where do
//             gap returners go" question.
//
// All data tagged with a `tl-` discordId prefix and INTERNAL visibility
// on seasons so it's safe to nuke with --reset. Prints the round id at
// the end so you can navigate straight to /admin/signups/<id>/build.
//
// Usage:
//   npm run seed:test-league -- --scenario fresh
//   npm run seed:test-league -- --scenario refresh
//   npm run seed:test-league -- --scenario gap
//   npm run seed:test-league -- --reset                # wipes all tl-* data first

import { prisma } from "../db.js";

// Marker we stash in Season.subtitle for prior test-league seasons so
// the reset path can find + nuke them without trampling real seasons.
const TEST_LEAGUE_SUBTITLE_PREFIX = "Test League ";

type Scenario = "fresh" | "refresh" | "gap";

interface Args {
  scenario: Scenario;
  reset: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return def;
    return argv[idx + 1] ?? def;
  };
  const scenario = get("--scenario", "fresh") as Scenario;
  if (!["fresh", "refresh", "gap"].includes(scenario)) {
    console.error("--scenario must be fresh | refresh | gap");
    process.exit(1);
  }
  return { scenario, reset: argv.includes("--reset") };
}

// Tiny deterministic PRNG so test seeds are reproducible across runs.
// Seeded with the scenario name so each scenario has consistent fake
// data even when reset+reseed.
function makeRng(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// BMP MMR distribution roughly matching the live site: mean ~210,
// median ~182, fat tail above 400. Weighted by tier.
function sampleMmr(rand: () => number): number {
  const r = rand();
  if (r < 0.50) return Math.floor(80 + rand() * 170);    // Stone: 80-249
  if (r < 0.75) return Math.floor(250 + rand() * 70);    // Steel: 250-319
  if (r < 0.90) return Math.floor(320 + rand() * 140);   // Gold: 320-459
  if (r < 0.97) return Math.floor(460 + rand() * 160);   // Lucky: 460-619
  return Math.floor(620 + rand() * 200);                 // Glass: 620-819
}

function mmrToTier(mmr: number): string {
  if (mmr < 250) return "Stone";
  if (mmr < 320) return "Steel";
  if (mmr < 460) return "Gold";
  if (mmr < 620) return "Lucky";
  return "Glass";
}

// Goofy display name generator — adjective + noun + 3-digit suffix so
// names are scannable in admin views without being real-person-looking.
const ADJS = ["Lucky", "Wild", "Mystic", "Rapid", "Stoic", "Bold", "Cosmic", "Quiet", "Vivid", "Sly"];
const NOUNS = ["Joker", "Deck", "Stake", "Hand", "Suit", "Chip", "Mult", "Glass", "Foil", "Holo"];
function fakeName(rand: () => number, n: number): string {
  const adj = ADJS[Math.floor(rand() * ADJS.length)] ?? "Test";
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)] ?? "Player";
  return `${adj}${noun}${String(n).padStart(3, "0")}`;
}

async function resetTestLeagueData(): Promise<void> {
  console.log("Resetting tl-* test data...");
  // Order matters: children before parents.
  await prisma.playerMmrSnapshot.deleteMany({ where: { discordId: { startsWith: "tl-" } } });
  await prisma.signup.deleteMany({ where: { discordId: { startsWith: "tl-" } } });
  await prisma.signupRound.deleteMany({ where: { name: { startsWith: "Test League " } } });
  await prisma.pairing.deleteMany({ where: { OR: [
    { playerA: { discordId: { startsWith: "tl-" } } },
    { playerB: { discordId: { startsWith: "tl-" } } },
  ]}});
  await prisma.divisionMember.deleteMany({ where: { player: { discordId: { startsWith: "tl-" } } } });
  await prisma.division.deleteMany({ where: { season: { subtitle: { startsWith: TEST_LEAGUE_SUBTITLE_PREFIX } } } });
  await prisma.tier.deleteMany({ where: { season: { subtitle: { startsWith: TEST_LEAGUE_SUBTITLE_PREFIX } } } });
  await prisma.season.deleteMany({ where: { subtitle: { startsWith: TEST_LEAGUE_SUBTITLE_PREFIX } } });
  await prisma.player.deleteMany({ where: { discordId: { startsWith: "tl-" } } });
}

interface SignupSpec {
  discordId: string;
  displayName: string;
  // BMP MMR snapshot fields. null = no balatromp account in scenario.
  currentMmr: number | null;
  priorMmr: number | null;
  // If set, create a Player row + prior season membership tied to this
  // discord id. priorRank/priorMembers describe their finishing position.
  priorSeason?: {
    tierName: "Common" | "Uncommon" | "Rare" | "Legendary";
    divisionName: string;
    rank: number;
    totalMembers: number;
    // Seasons-ago: 1 = last season, 2 = skipped one season ago.
    seasonsAgo: number;
  };
}

async function createPriorSeasonAndMembership(
  spec: SignupSpec,
  priorSeasonsByName: Map<string, { id: string; tiers: Map<string, string> /* tierName -> tierId */; divisions: Map<string, string> /* divName -> divisionId */ }>,
): Promise<string> {
  // Player row (used to anchor the prior membership + linkable from the
  // current signup via discordId).
  const player = await prisma.player.upsert({
    where: { discordId: spec.discordId },
    create: { discordId: spec.discordId, displayName: spec.displayName, hasCustomDisplayName: true },
    update: {},
  });
  const ps = spec.priorSeason!;
  // Stable identifier per (seasonsAgo) — same logical season collapses
  // across all signups in this run. The actual stored fields are number +
  // subtitle ("Test League prior").
  const seasonKey = `prior-S${10 - ps.seasonsAgo}`;
  let cached = priorSeasonsByName.get(seasonKey);
  if (!cached) {
    // Pick a unique number outside the live-season range. Each run is
    // run inside resetTestLeagueData so collisions are bounded; reserve
    // 9000-series for the test-league prior seasons.
    const baseNumber = 9000;
    const number = baseNumber + (10 - ps.seasonsAgo);
    const season = await prisma.season.create({
      data: {
        number,
        subtitle: `${TEST_LEAGUE_SUBTITLE_PREFIX}S${10 - ps.seasonsAgo} (prior)`,
        isActive: false,
        archivedAt: new Date(),
        visibility: "INTERNAL",
        endedAt: new Date(Date.now() - ps.seasonsAgo * 14 * 24 * 60 * 60 * 1000),
      },
    });
    cached = { id: season.id, tiers: new Map(), divisions: new Map() };
    priorSeasonsByName.set(seasonKey, cached);
  }
  let tierId = cached.tiers.get(ps.tierName);
  if (!tierId) {
    const position = { Legendary: 1, Rare: 2, Uncommon: 3, Common: 4 }[ps.tierName];
    const tier = await prisma.tier.create({ data: { seasonId: cached.id, position, name: ps.tierName } });
    tierId = tier.id;
    cached.tiers.set(ps.tierName, tierId);
  }
  let divisionId = cached.divisions.get(ps.divisionName);
  if (!divisionId) {
    const division = await prisma.division.create({
      data: { seasonId: cached.id, tierId, name: ps.divisionName, groupNumber: cached.divisions.size + 1 },
    });
    divisionId = division.id;
    cached.divisions.set(ps.divisionName, divisionId);
  }
  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId, playerId: player.id } },
    create: { divisionId, playerId: player.id, seasonId: cached.id, status: "ACTIVE" },
    update: {},
  });
  return cached.id;
}

async function writeSnapshots(spec: SignupSpec, priorSeasonId: string | null): Promise<void> {
  // Current (no seasonId — pre-build, same as the live capture flow at signup-close).
  if (spec.currentMmr != null) {
    await prisma.playerMmrSnapshot.create({
      data: {
        discordId: spec.discordId,
        seasonId: null,
        rankedMmr: spec.currentMmr,
        rankedTier: mmrToTier(spec.currentMmr),
        totalGames: 50 + Math.floor(spec.currentMmr / 10),
        winRatePct: Math.max(20, Math.min(80, 40 + Math.floor((spec.currentMmr - 200) / 12))),
      },
    });
  }
  // Prior season snapshot — tied to the prior season's id so the
  // profile-page "previous season" view picks it up.
  if (spec.priorMmr != null && priorSeasonId) {
    await prisma.playerMmrSnapshot.create({
      data: {
        discordId: spec.discordId,
        seasonId: priorSeasonId,
        rankedMmr: spec.priorMmr,
        rankedTier: mmrToTier(spec.priorMmr),
        totalGames: 30 + Math.floor(spec.priorMmr / 12),
        winRatePct: Math.max(20, Math.min(80, 40 + Math.floor((spec.priorMmr - 200) / 12))),
        capturedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      },
    });
  }
}

async function seedSignups(specs: SignupSpec[]): Promise<string> {
  const roundName = `Test League ${specs.length} signups (${new Date().toISOString().slice(0, 16)})`;
  const round = await prisma.signupRound.create({
    data: {
      name: roundName,
      guildId: "tl-test-guild",
      channelId: "tl-test-channel",
      messageId: "pending",
      status: "CLOSED", // ready to build immediately
      closedAt: new Date(),
    },
  });
  const priorSeasonsByName = new Map<string, { id: string; tiers: Map<string, string>; divisions: Map<string, string> }>();
  for (const spec of specs) {
    let priorSeasonId: string | null = null;
    if (spec.priorSeason) {
      priorSeasonId = await createPriorSeasonAndMembership(spec, priorSeasonsByName);
    }
    await prisma.signup.create({
      data: {
        roundId: round.id,
        discordId: spec.discordId,
        displayName: spec.displayName,
        signedUpAt: new Date(),
      },
    });
    await writeSnapshots(spec, priorSeasonId);
  }
  return round.id;
}

async function seedFresh(): Promise<string> {
  const rand = makeRng("fresh-2026");
  const specs: SignupSpec[] = Array.from({ length: 100 }, (_, i) => {
    const n = i + 1;
    return {
      discordId: `tl-fresh-${String(n).padStart(3, "0")}`,
      displayName: fakeName(rand, n),
      // 10% have no balatromp account at all — admin has to place them blind.
      currentMmr: rand() < 0.1 ? null : sampleMmr(rand),
      priorMmr: null, // brand new, no prior snapshot
    };
  });
  return seedSignups(specs);
}

async function seedRefresh(): Promise<string> {
  const rand = makeRng("refresh-2026");
  const TIERS: Array<["Legendary" | "Rare" | "Uncommon" | "Common", number]> = [
    ["Legendary", 1], ["Rare", 4], ["Uncommon", 6], ["Common", 6],
  ];
  const specs: SignupSpec[] = [];

  // 80 returners — spread across the prior season's divisions to reflect
  // actual season-end distribution.
  let returnerIdx = 0;
  for (const [tierName, divCount] of TIERS) {
    for (let d = 1; d <= divCount; d++) {
      const divisionName = tierName === "Legendary" ? "Legendary" : `${tierName} ${d}`;
      const playersInDiv = 5; // ~5/div × ~17 divisions = ~85, trim to 80
      for (let rank = 1; rank <= playersInDiv && returnerIdx < 80; rank++) {
        returnerIdx++;
        const n = returnerIdx;
        // MMR for returners loosely correlates with tier — Legendary returners
        // higher, Common returners lower, plus noise.
        const tierBaseMmr = { Legendary: 600, Rare: 480, Uncommon: 350, Common: 220 }[tierName];
        const currentMmr = Math.max(50, Math.floor(tierBaseMmr + (rand() - 0.5) * 200));
        const priorMmr = Math.max(50, Math.floor(currentMmr + (rand() - 0.5) * 80)); // mild drift
        specs.push({
          discordId: `tl-ret-${String(n).padStart(3, "0")}`,
          displayName: fakeName(rand, n),
          currentMmr,
          priorMmr,
          priorSeason: { tierName, divisionName, rank, totalMembers: playersInDiv, seasonsAgo: 1 },
        });
      }
    }
  }
  // 20 brand-new players.
  for (let i = 1; i <= 20; i++) {
    specs.push({
      discordId: `tl-new-${String(i).padStart(3, "0")}`,
      displayName: fakeName(rand, 100 + i),
      currentMmr: rand() < 0.15 ? null : sampleMmr(rand),
      priorMmr: null,
    });
  }
  return seedSignups(specs);
}

async function seedGap(): Promise<string> {
  const rand = makeRng("gap-2026");
  const TIERS: Array<["Legendary" | "Rare" | "Uncommon" | "Common", number]> = [
    ["Legendary", 1], ["Rare", 3], ["Uncommon", 4], ["Common", 4],
  ];
  const specs: SignupSpec[] = [];

  // 60 recent returners (seasonsAgo: 1)
  let returnerIdx = 0;
  outer: for (const [tierName, divCount] of TIERS) {
    for (let d = 1; d <= divCount; d++) {
      const divisionName = tierName === "Legendary" ? "Legendary" : `${tierName} ${d}`;
      for (let rank = 1; rank <= 5; rank++) {
        if (returnerIdx >= 60) break outer;
        returnerIdx++;
        const n = returnerIdx;
        const tierBaseMmr = { Legendary: 600, Rare: 480, Uncommon: 350, Common: 220 }[tierName];
        const currentMmr = Math.max(50, Math.floor(tierBaseMmr + (rand() - 0.5) * 200));
        const priorMmr = Math.max(50, Math.floor(currentMmr + (rand() - 0.5) * 80));
        specs.push({
          discordId: `tl-ret-${String(n).padStart(3, "0")}`,
          displayName: fakeName(rand, n),
          currentMmr,
          priorMmr,
          priorSeason: { tierName, divisionName, rank, totalMembers: 5, seasonsAgo: 1 },
        });
      }
    }
  }
  // 10 GAP returners — played 2 seasons ago, skipped last season.
  for (let i = 1; i <= 10; i++) {
    const tierNames: Array<"Legendary" | "Rare" | "Uncommon" | "Common"> = ["Rare", "Uncommon", "Common"];
    const tierName = tierNames[i % 3]!;
    const tierBaseMmr = { Legendary: 600, Rare: 480, Uncommon: 350, Common: 220 }[tierName];
    const currentMmr = Math.max(50, Math.floor(tierBaseMmr + (rand() - 0.5) * 240));
    specs.push({
      discordId: `tl-gap-${String(i).padStart(3, "0")}`,
      displayName: fakeName(rand, 200 + i),
      currentMmr,
      priorMmr: Math.max(50, Math.floor(currentMmr + (rand() - 0.5) * 120)),
      priorSeason: {
        tierName,
        divisionName: tierName === "Legendary" ? "Legendary" : `${tierName} ${1 + (i % 3)}`,
        rank: 1 + (i % 5),
        totalMembers: 5,
        seasonsAgo: 2,
      },
    });
  }
  // 20 brand-new players.
  for (let i = 1; i <= 20; i++) {
    specs.push({
      discordId: `tl-new-${String(i).padStart(3, "0")}`,
      displayName: fakeName(rand, 300 + i),
      currentMmr: rand() < 0.15 ? null : sampleMmr(rand),
      priorMmr: null,
    });
  }
  return seedSignups(specs);
}

const args = parseArgs();
if (args.reset) {
  await resetTestLeagueData();
}
console.log(`Seeding scenario: ${args.scenario}`);
const roundId =
  args.scenario === "fresh" ? await seedFresh() :
  args.scenario === "refresh" ? await seedRefresh() :
  await seedGap();

console.log(`\n✓ Done. Navigate to:`);
console.log(`  /admin/signups/${roundId}/build`);
console.log(`\nTo wipe and reseed: npm run seed:test-league -- --scenario ${args.scenario} --reset`);
process.exit(0);
