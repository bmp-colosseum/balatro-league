// Plan + commit a new season from a finalized signup round.
//
// Model B placement (top-down refill):
//   1. Bucket each signup into their TARGET rarity using prior-season promo/relegation:
//      - TOP of prior division → next-higher rarity
//      - BOTTOM of prior division → next-lower rarity
//      - MIDDLE → stay
//      - No prior placement → Common
//   2. Top-down refill: walk rarities from LEGENDARY down. Each rarity has a target capacity
//      (group-size × number of divisions in the pyramid). If a rarity is short of capacity,
//      pull the top of the rarity below to fill it. Cascade so Common absorbs the bottom.
//   3. Pack each rarity into divisions of size targetGroupSize (last division can be smaller,
//      but only if it would have at least minGroupSize players — otherwise extras stay
//      unassigned and admin gets a warning).

import { Rarity, type Player, type Signup } from "@prisma/client";
import { prisma } from "./db.js";
import { buildPyramid, PLAYERS_PER_DIVISION } from "./pyramid.js";
import { computeStandings } from "./standings.js";

const RARITY_ORDER: Rarity[] = ["COMMON", "UNCOMMON", "RARE", "LEGENDARY"];

function rarityAbove(r: Rarity): Rarity {
  const i = RARITY_ORDER.indexOf(r);
  return i === RARITY_ORDER.length - 1 ? r : RARITY_ORDER[i + 1]!;
}
function rarityBelow(r: Rarity): Rarity {
  const i = RARITY_ORDER.indexOf(r);
  return i === 0 ? r : RARITY_ORDER[i - 1]!;
}

export interface PlacementPlan {
  rarityCounts: Record<Rarity, number>;
  divisions: Array<{ rarity: Rarity; groupNumber: number; name: string; signupIds: string[] }>;
  warnings: string[];
  unassigned: string[]; // signup ids that couldn't fit into a division ≥ minGroupSize
}

export async function planSeason(
  roundId: string,
  opts: { targetGroupSize?: number; minGroupSize?: number } = {},
): Promise<PlacementPlan> {
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: {
      signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } },
    },
  });
  if (!round) throw new Error(`No signup round ${roundId}`);

  const targetGroupSize = opts.targetGroupSize ?? PLAYERS_PER_DIVISION;
  const minGroupSize = opts.minGroupSize ?? 3;

  const previousSeason = await prisma.season.findFirst({
    where: { isActive: false, endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    include: {
      divisions: {
        include: {
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

  // Map: discordId → { rarity, placement } from prior season
  interface PriorPlacement { rarity: Rarity; placement: "TOP" | "MIDDLE" | "BOTTOM"; rank: number }
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
          rarity: division.rarity,
          placement,
          rank: idx,
        });
      });
    }
  }

  // Step 1: target rarity per signup
  interface Bucketed {
    signup: Signup;
    prior: PriorPlacement | null;
  }
  const buckets: Record<Rarity, Bucketed[]> = {
    LEGENDARY: [],
    RARE: [],
    UNCOMMON: [],
    COMMON: [],
  };

  for (const signup of round.signups) {
    const prior = priorByDiscordId.get(signup.discordId) ?? null;
    let target: Rarity;
    if (!prior) {
      target = "COMMON";
    } else if (prior.placement === "TOP") {
      target = rarityAbove(prior.rarity);
    } else if (prior.placement === "BOTTOM") {
      target = rarityBelow(prior.rarity);
    } else {
      target = prior.rarity;
    }
    buckets[target].push({ signup, prior });
  }

  // Default pyramid shape (number of divisions per rarity).
  const pyramidCounts: Record<Rarity, number> = {
    LEGENDARY: 1,
    RARE: 4,
    UNCOMMON: 6,
    COMMON: 6,
  };

  // Step 2: top-down refill. Each rarity has target capacity = divisions × targetGroupSize.
  // If a rarity is short, pull the top-ranked players from the rarity below.
  // Ranking within a bucket: prior TOP > MIDDLE > BOTTOM, then by prior rank ascending.
  function rankWithin(b: Bucketed): number {
    if (!b.prior) return 999;
    if (b.prior.placement === "TOP") return 0 + b.prior.rank;
    if (b.prior.placement === "MIDDLE") return 100 + b.prior.rank;
    return 200 + b.prior.rank;
  }

  for (const rarity of ["LEGENDARY", "RARE", "UNCOMMON"] as Rarity[]) {
    const target = pyramidCounts[rarity] * targetGroupSize;
    while (buckets[rarity].length < target) {
      const below = rarityBelow(rarity);
      if (below === rarity || buckets[below].length === 0) break;
      // Pull the highest-ranked from the rarity below
      buckets[below].sort((a, b) => rankWithin(a) - rankWithin(b));
      const promoted = buckets[below].shift()!;
      buckets[rarity].push(promoted);
      warnings.push(`Pulled **${promoted.signup.displayName}** up to ${titleCase(rarity)} to fill capacity.`);
    }
  }

  // Common absorbs any extra. If Common overflows its pyramid count, grow it.
  for (const r of ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"] as Rarity[]) {
    const needDivisions = Math.ceil(buckets[r].length / targetGroupSize);
    if (needDivisions > pyramidCounts[r]) {
      const grew = needDivisions - pyramidCounts[r];
      pyramidCounts[r] = needDivisions;
      warnings.push(
        `${titleCase(r)} expanded by ${grew} division(s) to fit ${buckets[r].length} player(s).`,
      );
    }
  }

  // Step 3: pack each rarity into divisions. Round-robin distribution within rarity.
  const slots = buildPyramid(pyramidCounts);
  const divisions: PlacementPlan["divisions"] = [];
  const unassigned: string[] = [];

  for (const r of ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"] as Rarity[]) {
    const slotsForRarity = slots.filter((s) => s.rarity === r);
    const bucketed = buckets[r];

    if (slotsForRarity.length === 0 && bucketed.length > 0) {
      warnings.push(
        `No ${titleCase(r)} slots configured but ${bucketed.length} player(s) wanted that tier — moved to Common.`,
      );
      buckets.COMMON.push(...bucketed);
      continue;
    }

    // How many divisions can we actually fill given minGroupSize?
    // Drop divisions from the tail if they'd be too small.
    let activeDivisionCount = slotsForRarity.length;
    while (activeDivisionCount > 1) {
      const wouldFit = bucketed.length;
      const avgIfShrunk = wouldFit / (activeDivisionCount - 1);
      const lastDivCount = wouldFit - (activeDivisionCount - 1) * Math.floor(avgIfShrunk);
      // If shrinking would still keep all divs ≥ minGroupSize, do it
      if (Math.floor(wouldFit / activeDivisionCount) >= minGroupSize) break;
      activeDivisionCount--;
      // Cap at last division being below min
      void lastDivCount;
    }

    // Final check: if the bucket has at least minGroupSize, fill at least one division
    if (bucketed.length > 0 && bucketed.length < minGroupSize) {
      warnings.push(
        `${titleCase(r)} only has ${bucketed.length} player(s) — below min group size (${minGroupSize}). Leaving them unassigned.`,
      );
      for (const b of bucketed) unassigned.push(b.signup.id);
      // Emit empty divisions so the season still has the slot structure
      for (const slot of slotsForRarity) {
        divisions.push({
          rarity: slot.rarity,
          groupNumber: slot.groupNumber,
          name: slot.name,
          signupIds: [],
        });
      }
      continue;
    }

    activeDivisionCount = Math.max(1, Math.min(activeDivisionCount, slotsForRarity.length));
    if (activeDivisionCount < slotsForRarity.length) {
      const skipped = slotsForRarity.length - activeDivisionCount;
      warnings.push(
        `${titleCase(r)} consolidated to ${activeDivisionCount} division(s) (${skipped} left empty) to keep group sizes ≥ ${minGroupSize}.`,
      );
    }

    const assignment: Record<number, string[]> = {};
    slotsForRarity.forEach((s) => {
      assignment[s.groupNumber] = [];
    });

    let cursor = 0;
    for (const b of bucketed) {
      const slot = slotsForRarity[cursor % activeDivisionCount]!;
      assignment[slot.groupNumber]!.push(b.signup.id);
      cursor++;
    }

    for (const slot of slotsForRarity) {
      divisions.push({
        rarity: slot.rarity,
        groupNumber: slot.groupNumber,
        name: slot.name,
        signupIds: assignment[slot.groupNumber] ?? [],
      });
    }
  }

  return {
    rarityCounts: {
      LEGENDARY: buckets.LEGENDARY.length,
      RARE: buckets.RARE.length,
      UNCOMMON: buckets.UNCOMMON.length,
      COMMON: buckets.COMMON.length,
    },
    divisions,
    warnings,
    unassigned,
  };
}

export async function commitSeason(
  roundId: string,
  seasonName: string,
  deadline: Date | null,
  opts: { targetGroupSize?: number; minGroupSize?: number } = {},
): Promise<{ seasonId: string; divisionsCreated: number; playersPlaced: number; unassigned: number }> {
  const plan = await planSeason(roundId, opts);

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: true },
  });
  if (!round) throw new Error(`No signup round ${roundId}`);
  const signupById = new Map(round.signups.map((s) => [s.id, s]));

  const season = await prisma.season.create({
    data: {
      name: seasonName,
      deadline,
      isActive: false,
      targetGroupSize: opts.targetGroupSize ?? PLAYERS_PER_DIVISION,
      minGroupSize: opts.minGroupSize ?? 3,
    },
  });

  let divisionsCreated = 0;
  let playersPlaced = 0;

  for (const div of plan.divisions) {
    const division = await prisma.division.create({
      data: {
        seasonId: season.id,
        rarity: div.rarity,
        groupNumber: div.groupNumber,
        name: div.name,
      },
    });
    divisionsCreated++;
    for (const signupId of div.signupIds) {
      const signup = signupById.get(signupId);
      if (!signup) continue;
      const player = await prisma.player.upsert({
        where: { discordId: signup.discordId },
        create: { discordId: signup.discordId, displayName: signup.displayName },
        update: { displayName: signup.displayName },
      });
      await prisma.divisionMember.create({
        data: { divisionId: division.id, playerId: player.id },
      });
      playersPlaced++;
    }
  }

  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "BUILT", resultingSeasonId: season.id },
  });

  return {
    seasonId: season.id,
    divisionsCreated,
    playersPlaced,
    unassigned: plan.unassigned.length,
  };
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
