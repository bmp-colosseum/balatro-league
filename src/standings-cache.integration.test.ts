// Integration test: exercises the standings cache against a REAL Postgres
// (embedded, booted by vitest.integration.config.ts). Seeds a division with
// real rows, then verifies recompute writes a cache and load reads it back
// correctly sorted — the kind of thing unit tests with mocks can't prove.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Player } from "@prisma/client";
import { prisma } from "./db.js";
import { recomputeDivisionStandings, loadDivisionStandings } from "./standings-cache.js";

async function reset(): Promise<void> {
  // FK-safe order.
  await prisma.divisionStandings.deleteMany();
  await prisma.match.deleteMany();
  await prisma.divisionMember.deleteMany();
  await prisma.division.deleteMany();
  await prisma.tier.deleteMany();
  await prisma.season.deleteMany();
  await prisma.player.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedDivision() {
  const season = await prisma.season.create({ data: { number: 1, isActive: true } });
  const tier = await prisma.tier.create({ data: { seasonId: season.id, position: 1, name: "Test" } });
  const division = await prisma.division.create({
    data: { seasonId: season.id, tierId: tier.id, groupNumber: 1, name: "Test 1" },
  });
  const mk = async (discordId: string, displayName: string): Promise<Player> => {
    const p = await prisma.player.create({ data: { discordId, displayName } });
    await prisma.divisionMember.create({
      data: { divisionId: division.id, seasonId: season.id, playerId: p.id, status: "ACTIVE" },
    });
    return p;
  };
  const a = await mk("d-a", "Alice");
  const b = await mk("d-b", "Bob");
  const c = await mk("d-c", "Cara");
  return { division, a, b, c };
}

// Records a CONFIRMED best-of-2, canonicalising player order (A.id < B.id) the
// way the app does so the result lands on the right side.
async function recordMatch(divisionId: string, p1: Player, p2: Player, g1: number, g2: number) {
  const [aId, bId, ga, gb] = p1.id < p2.id ? [p1.id, p2.id, g1, g2] : [p2.id, p1.id, g2, g1];
  await prisma.match.create({
    data: {
      divisionId,
      playerAId: aId,
      playerBId: bId,
      format: "LEAGUE_BO2",
      gamesWonA: ga,
      gamesWonB: gb,
      winnerId: ga > gb ? aId : gb > ga ? bId : null,
      status: "CONFIRMED",
    },
  });
}

describe("standings-cache (real Postgres)", () => {
  it("recompute writes a cache; load reads it back, sorted and scored", async () => {
    const { division, a, b, c } = await seedDivision();
    await recordMatch(division.id, a, b, 2, 0); // Alice beats Bob
    await recordMatch(division.id, a, c, 2, 0); // Alice beats Cara
    await recordMatch(division.id, b, c, 1, 1); // Bob draws Cara

    await recomputeDivisionStandings(division.id);

    const cached = await prisma.divisionStandings.findUnique({ where: { divisionId: division.id } });
    expect(cached).not.toBeNull();

    const rows = await loadDivisionStandings(division.id);
    // Alice 6 (two 2-0 wins); Bob & Cara 1 each (their draw). Bob before Cara on name.
    expect(rows.map((r) => r.player.id)).toEqual([a.id, b.id, c.id]);
    expect(rows.map((r) => r.points)).toEqual([6, 1, 1]);
    expect(rows[0]).toMatchObject({ wins: 2, draws: 0, losses: 0, played: 2, gamesWon: 4, gamesLost: 0 });
  });

  it("cold cache: load computes + persists when no cache row exists yet", async () => {
    const { division, a, b } = await seedDivision();
    await recordMatch(division.id, a, b, 2, 0);

    // No recompute call — cache is cold.
    expect(await prisma.divisionStandings.findUnique({ where: { divisionId: division.id } })).toBeNull();

    const rows = await loadDivisionStandings(division.id);
    expect(rows.find((r) => r.player.id === a.id)!.points).toBe(3);

    // load should have warmed the cache as a side effect.
    expect(await prisma.divisionStandings.findUnique({ where: { divisionId: division.id } })).not.toBeNull();
  });
});
