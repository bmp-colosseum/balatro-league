// Plan + commit a new season from a finalized signup round.
//
// Model (per-season custom tiers):
//   Each season has an ordered list of tiers (position 1..N, top → bottom).
//   Each tier has 1+ divisions.
//
// Placement (top-down refill):
//   1. Bucket each signup into a TARGET tier position using prior-season promo/relegation
//      against TIER NAME match. (If prior season's tier names don't match new season's,
//      everyone falls back to the bottom tier.)
//      - TOP of prior division → promote one tier up (position - 1)
//      - BOTTOM of prior division → relegate one tier down (position + 1)
//      - MIDDLE → stay at same tier (by name)
//      - No prior placement → bottom tier
//   2. Top-down refill: for each tier 1..N, if it's short of capacity, pull the
//      best-ranked player from the tier below. Cascade so bottom absorbs the overflow.
//   3. Pack each tier into its divisions round-robin. Tiers with fewer than
//      minGroupSize players → leftover signups stay unassigned, warn admin.

import { type Player, type Signup } from "@prisma/client";
import { prisma } from "./db.js";
import { DEFAULT_TIERS, parseTierConfig, PLAYERS_PER_DIVISION, type TierConfig } from "./pyramid.js";
import { computeStandings } from "./standings.js";
import { createTiersAndDivisions } from "./tiers.js";

export interface PlacementPlan {
  tiers: Array<{
    name: string;
    position: number;
    playerCount: number;
    divisions: Array<{ groupNumber: number; name: string; signupIds: string[] }>;
  }>;
  warnings: string[];
  unassigned: string[]; // signup ids that couldn't fit into a tier ≥ minGroupSize
}

export interface PlanOpts {
  tiers?: TierConfig[];          // new season's tier shape (default: DEFAULT_TIERS)
  targetGroupSize?: number;
  minGroupSize?: number;
}

export async function planSeason(roundId: string, opts: PlanOpts = {}): Promise<PlacementPlan> {
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: {
      signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } },
    },
  });
  if (!round) throw new Error(`No signup round ${roundId}`);

  const tierConfigs = opts.tiers ?? DEFAULT_TIERS;
  const targetGroupSize = opts.targetGroupSize ?? PLAYERS_PER_DIVISION;
  const minGroupSize = opts.minGroupSize ?? 3;

  // Load prior season for promo/relegation lookups
  const previousSeason = await prisma.season.findFirst({
    where: { isActive: false, endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        include: {
          tier: true,
          members: { include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });

  const warnings: string[] = [];

  // Map: discordId → { tierName, placement } from prior season
  interface PriorPlacement { tierName: string; placement: "TOP" | "MIDDLE" | "BOTTOM"; rank: number }
  const priorByDiscordId = new Map<string, PriorPlacement>();
  if (previousSeason) {
    for (const division of previousSeason.divisions) {
      const players: Player[] = division.members.map((m) => m.player);
      if (players.length === 0) continue;
      const rows = computeStandings(players, division.pairings);
      rows.forEach((row, idx) => {
        let placement: "TOP" | "MIDDLE" | "BOTTOM";
        if (idx === 0) placement = "TOP";
        else if (idx === rows.length - 1) placement = "BOTTOM";
        else placement = "MIDDLE";
        priorByDiscordId.set(row.player.discordId, {
          tierName: division.tier.name,
          placement,
          rank: idx,
        });
      });
    }
  }

  // Bucket signups by target tier position (1-indexed)
  interface Bucketed { signup: Signup; prior: PriorPlacement | null }
  const numTiers = tierConfigs.length;
  const buckets: Bucketed[][] = Array.from({ length: numTiers }, () => []);

  // Helper: tier name → position in NEW season (-1 if not found)
  const nameToPosition = new Map<string, number>();
  tierConfigs.forEach((t, i) => nameToPosition.set(t.name, i + 1));

  for (const signup of round.signups) {
    const prior = priorByDiscordId.get(signup.discordId) ?? null;
    let targetPosition: number;
    if (!prior) {
      targetPosition = numTiers; // bottom
    } else {
      const samePos = nameToPosition.get(prior.tierName);
      if (samePos === undefined) {
        // Prior tier name doesn't exist in new season — drop to bottom
        targetPosition = numTiers;
      } else if (prior.placement === "TOP") {
        targetPosition = Math.max(1, samePos - 1);
      } else if (prior.placement === "BOTTOM") {
        targetPosition = Math.min(numTiers, samePos + 1);
      } else {
        targetPosition = samePos;
      }
    }
    buckets[targetPosition - 1]!.push({ signup, prior });
  }

  // Top-down refill: for each tier 1..N, pull from below if under capacity.
  function rankWithin(b: Bucketed): number {
    if (!b.prior) return 999;
    if (b.prior.placement === "TOP") return 0 + b.prior.rank;
    if (b.prior.placement === "MIDDLE") return 100 + b.prior.rank;
    return 200 + b.prior.rank;
  }

  for (let i = 0; i < numTiers - 1; i++) {
    const target = tierConfigs[i]!.divisionCount * targetGroupSize;
    while (buckets[i]!.length < target) {
      const below = buckets[i + 1]!;
      if (below.length === 0) break;
      below.sort((a, b) => rankWithin(a) - rankWithin(b));
      const promoted = below.shift()!;
      buckets[i]!.push(promoted);
      warnings.push(`Pulled **${promoted.signup.displayName}** up to ${tierConfigs[i]!.name} to fill capacity.`);
    }
  }

  // For each tier: pack signups into its divisions (round-robin).
  // If overflow, expand its division count. If under minGroupSize, mark unassigned.
  const planTiers: PlacementPlan["tiers"] = [];
  const unassigned: string[] = [];

  for (let i = 0; i < numTiers; i++) {
    const config = tierConfigs[i]!;
    const bucket = buckets[i]!;
    let actualDivisions = config.divisionCount;

    // If too few players for even one full-min division, leave tier empty
    if (bucket.length > 0 && bucket.length < minGroupSize) {
      warnings.push(
        `${config.name} only has ${bucket.length} player(s) — below min group size (${minGroupSize}). Leaving them unassigned.`,
      );
      for (const b of bucket) unassigned.push(b.signup.id);
      planTiers.push({
        name: config.name,
        position: i + 1,
        playerCount: 0,
        divisions: Array.from({ length: config.divisionCount }, (_, gi) => ({
          groupNumber: gi + 1,
          name: config.divisionCount === 1 ? config.name : `${config.name} ${gi + 1}`,
          signupIds: [],
        })),
      });
      continue;
    }

    // Expand divisions if bucket overflows configured count
    const needed = Math.ceil(bucket.length / targetGroupSize);
    if (needed > actualDivisions) {
      const grew = needed - actualDivisions;
      actualDivisions = needed;
      warnings.push(`${config.name} expanded by ${grew} division(s) to fit ${bucket.length} player(s).`);
    }

    // Consolidate if shrinking would still respect min size
    let used = actualDivisions;
    while (used > 1) {
      const avgIfShrunk = Math.floor(bucket.length / (used - 1));
      if (avgIfShrunk < minGroupSize) break;
      used--;
    }
    if (used < actualDivisions) {
      warnings.push(`${config.name} consolidated to ${used} division(s) to keep group sizes ≥ ${minGroupSize}.`);
    }
    actualDivisions = used;

    // Round-robin assign
    const assignments: string[][] = Array.from({ length: actualDivisions }, () => []);
    bucket.forEach((b, idx) => {
      assignments[idx % actualDivisions]!.push(b.signup.id);
    });

    // Build divisions array (use the configured count for total slots, fill assignments)
    const divisions: PlacementPlan["tiers"][number]["divisions"] = [];
    for (let gi = 0; gi < Math.max(actualDivisions, config.divisionCount); gi++) {
      const name = config.divisionCount === 1 && gi === 0 ? config.name : `${config.name} ${gi + 1}`;
      divisions.push({
        groupNumber: gi + 1,
        name,
        signupIds: assignments[gi] ?? [],
      });
    }

    planTiers.push({
      name: config.name,
      position: i + 1,
      playerCount: bucket.length,
      divisions,
    });
  }

  return { tiers: planTiers, warnings, unassigned };
}

export async function commitSeason(
  roundId: string,
  subtitle: string | null,
  deadline: Date | null,
  opts: PlanOpts = {},
): Promise<{ seasonId: string; tiersCreated: number; divisionsCreated: number; playersPlaced: number; unassigned: number }> {
  const plan = await planSeason(roundId, opts);
  const tierConfigs = opts.tiers ?? DEFAULT_TIERS;
  const targetGroupSize = opts.targetGroupSize ?? PLAYERS_PER_DIVISION;
  const minGroupSize = opts.minGroupSize ?? 3;

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: true },
  });
  if (!round) throw new Error(`No signup round ${roundId}`);
  const signupById = new Map(round.signups.map((s) => [s.id, s]));

  const agg = await prisma.season.aggregate({ _max: { number: true } });
  const number = (agg._max.number ?? 0) + 1;
  const season = await prisma.season.create({
    data: {
      number,
      subtitle,
      deadline,
      isActive: false,
      targetGroupSize,
      minGroupSize,
    },
  });

  // Note: createTiersAndDivisions uses the original config (not the plan's
  // possibly-expanded divisions). For commit, use what the plan actually produced.
  let tiersCreated = 0;
  let divisionsCreated = 0;
  let playersPlaced = 0;

  for (const planTier of plan.tiers) {
    const tier = await prisma.tier.create({
      data: { seasonId: season.id, position: planTier.position, name: planTier.name },
    });
    tiersCreated++;
    for (const planDiv of planTier.divisions) {
      const division = await prisma.division.create({
        data: {
          seasonId: season.id,
          tierId: tier.id,
          groupNumber: planDiv.groupNumber,
          name: planDiv.name,
        },
      });
      divisionsCreated++;
      for (const signupId of planDiv.signupIds) {
        const signup = signupById.get(signupId);
        if (!signup) continue;
        const player = await prisma.player.upsert({
          where: { discordId: signup.discordId },
          create: { discordId: signup.discordId, displayName: signup.displayName },
          update: { displayName: signup.displayName },
        });
        await prisma.divisionMember.create({
          data: { divisionId: division.id, seasonId: season.id, playerId: player.id },
        });
        playersPlaced++;
      }
    }
  }

  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "BUILT", resultingSeasonId: season.id },
  });

  // Silence unused warning (TierConfig used implicitly via opts.tiers default)
  void tierConfigs;
  void parseTierConfig;
  void createTiersAndDivisions;

  return {
    seasonId: season.id,
    tiersCreated,
    divisionsCreated,
    playersPlaced,
    unassigned: plan.unassigned.length,
  };
}
