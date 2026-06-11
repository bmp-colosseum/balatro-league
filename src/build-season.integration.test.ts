// Integration tests for planSeason (the placement brain) against a real
// Postgres. Covers the three behaviours most dangerous to break:
//   1. fresh season (no prior) — top-down fill across tiers
//   2. below-min-group-size tier — players left unassigned
//   3. promotion/relegation from a prior ended season (the scary one)

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db.js";
import { planSeason } from "./build-season.js";

async function reset(): Promise<void> {
  await prisma.divisionStandings.deleteMany();
  await prisma.match.deleteMany();
  await prisma.divisionMember.deleteMany();
  await prisma.signup.deleteMany();
  await prisma.signupRound.deleteMany();
  await prisma.division.deleteMany();
  await prisma.tier.deleteMany();
  await prisma.season.deleteMany();
  await prisma.player.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  await prisma.$disconnect();
});

// A CLOSED signup round with N signups. discordIds let us tie them to prior
// players. Returns the round id + the signup id for each discordId.
async function makeRound(discordIds: string[]) {
  const round = await prisma.signupRound.create({
    data: { name: "Test Round", guildId: "g", channelId: "c", messageId: "m", status: "CLOSED" },
  });
  const signupIdByDiscord: Record<string, string> = {};
  let t = 0;
  for (const discordId of discordIds) {
    const s = await prisma.signup.create({
      data: { roundId: round.id, discordId, displayName: discordId, signedUpAt: new Date(Date.now() + t++) },
    });
    signupIdByDiscord[discordId] = s.id;
  }
  return { roundId: round.id, signupIdByDiscord };
}

describe("planSeason — fresh season (no prior)", () => {
  it("fills the top tier from the bottom up to capacity", async () => {
    const { roundId } = await makeRound(["s1", "s2", "s3", "s4"]);
    const plan = await planSeason(roundId, {
      tiers: [
        { name: "Top", divisionCount: 1 },
        { name: "Bottom", divisionCount: 1 },
      ],
      targetGroupSize: 2,
      minGroupSize: 2,
    });

    expect(plan.tiers.map((t) => t.name)).toEqual(["Top", "Bottom"]);
    expect(plan.tiers[0]!.playerCount).toBe(2);
    expect(plan.tiers[1]!.playerCount).toBe(2);
    expect(plan.unassigned).toHaveLength(0);
    const assigned = plan.tiers.flatMap((t) => t.divisions.flatMap((d) => d.signupIds));
    expect(assigned).toHaveLength(4);
  });

  it("leaves a tier's players unassigned when below min group size", async () => {
    const { roundId, signupIdByDiscord } = await makeRound(["a", "b"]);
    const plan = await planSeason(roundId, {
      tiers: [{ name: "Solo", divisionCount: 1 }],
      targetGroupSize: 5,
      minGroupSize: 3,
    });
    expect(plan.unassigned).toHaveLength(2);
    expect(plan.unassigned).toEqual(expect.arrayContaining([signupIdByDiscord.a, signupIdByDiscord.b]));
    expect(plan.warnings.join(" ")).toMatch(/below min group size/i);
  });
});

describe("planSeason — promotion / relegation from prior season", () => {
  it("promotes division winners up a tier and relegates losers down", async () => {
    // Prior ended season with tiers Gold(1) > Silver(2), one division each.
    const prev = await prisma.season.create({
      data: { number: 1, isActive: false, endedAt: new Date() },
    });
    const gold = await prisma.tier.create({ data: { seasonId: prev.id, position: 1, name: "Gold" } });
    const silver = await prisma.tier.create({ data: { seasonId: prev.id, position: 2, name: "Silver" } });
    const goldDiv = await prisma.division.create({
      data: { seasonId: prev.id, tierId: gold.id, groupNumber: 1, name: "Gold 1" },
    });
    const silverDiv = await prisma.division.create({
      data: { seasonId: prev.id, tierId: silver.id, groupNumber: 1, name: "Silver 1" },
    });

    const mkMember = async (discordId: string, divisionId: string) => {
      const p = await prisma.player.create({ data: { discordId, displayName: discordId } });
      await prisma.divisionMember.create({
        data: { divisionId, seasonId: prev.id, playerId: p.id, status: "ACTIVE" },
      });
      return p;
    };
    const goldTop = await mkMember("goldTop", goldDiv.id);
    const goldBot = await mkMember("goldBot", goldDiv.id);
    const silverTop = await mkMember("silverTop", silverDiv.id);
    const silverBot = await mkMember("silverBot", silverDiv.id);

    const win = async (divisionId: string, winner: { id: string }, loser: { id: string }) => {
      const [aId, bId] = winner.id < loser.id ? [winner.id, loser.id] : [loser.id, winner.id];
      await prisma.match.create({
        data: {
          divisionId,
          playerAId: aId,
          playerBId: bId,
          format: "LEAGUE_BO2",
          gamesWonA: aId === winner.id ? 2 : 0,
          gamesWonB: bId === winner.id ? 2 : 0,
          winnerId: winner.id,
          status: "CONFIRMED",
        },
      });
    };
    await win(goldDiv.id, goldTop, goldBot); // goldTop = TOP of Gold, goldBot = BOTTOM
    await win(silverDiv.id, silverTop, silverBot); // silverTop = TOP of Silver, silverBot = BOTTOM

    const { roundId, signupIdByDiscord } = await makeRound(["goldTop", "goldBot", "silverTop", "silverBot"]);
    const plan = await planSeason(roundId, {
      tiers: [
        { name: "Gold", divisionCount: 1 },
        { name: "Silver", divisionCount: 1 },
      ],
      targetGroupSize: 2,
      minGroupSize: 2,
    });

    const tierOf = (signupId: string | undefined) =>
      signupId == null
        ? undefined
        : plan.tiers.find((t) => t.divisions.some((d) => d.signupIds.includes(signupId)))?.name;

    expect(tierOf(signupIdByDiscord.goldTop)).toBe("Gold"); // winner of top tier stays top
    expect(tierOf(signupIdByDiscord.goldBot)).toBe("Silver"); // relegated down
    expect(tierOf(signupIdByDiscord.silverTop)).toBe("Gold"); // promoted up
    expect(tierOf(signupIdByDiscord.silverBot)).toBe("Silver"); // stays bottom
  });
});
