// Shared helpers for mock data. All mock players have discordId starting with "mock-"
// (or "sim-" from the older simulator) so they're trivially identifiable and removable.

import type { Player } from "@prisma/client";
import { prisma } from "./db.js";
import { gamesFromResult, type PairingResult } from "./scoring.js";

export const MOCK_PREFIX = "mock-";
export const MOCK_PREFIXES = ["mock-", "sim-"] as const;

export function isMockPlayer(player: Pick<Player, "discordId">): boolean {
  return MOCK_PREFIXES.some((p) => player.discordId.startsWith(p));
}

// Mulberry32 — small seeded RNG so test runs are reproducible.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomResult(rand: () => number): PairingResult {
  const r = rand();
  if (r < 0.4) return "2-0";
  if (r < 0.6) return "1-1";
  return "0-2";
}

// Fill empty seats across the active season's divisions with mock players.
// Returns the number of seats filled and the list of divisions that were touched.
export async function seedMockPlayers(
  seasonId: string,
  capacityPerDiv: number,
  perDivisionLimit?: number,
): Promise<{ created: number; divisionsTouched: number }> {
  const divisions = await prisma.division.findMany({
    where: { seasonId },
    include: { _count: { select: { members: true } } },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });

  let created = 0;
  let divisionsTouched = 0;
  const nonce = Date.now().toString(36);

  for (const div of divisions) {
    const target = perDivisionLimit ?? capacityPerDiv;
    const needed = Math.max(0, target - div._count.members);
    if (needed === 0) continue;
    divisionsTouched++;

    for (let i = 0; i < needed; i++) {
      const discordId = `${MOCK_PREFIX}${nonce}-${div.id.slice(-4)}-${i}`;
      const displayName = `Mock ${div.name.replace(/\s/g, "")}-${div._count.members + i + 1}`;
      const player = await prisma.player.create({
        data: { discordId, displayName },
      });
      await prisma.divisionMember.create({
        data: { divisionId: div.id, seasonId: div.seasonId, playerId: player.id },
      });
      created++;
    }
  }

  return { created, divisionsTouched };
}

// Auto-play every UNPLAYED pairing within a division (where no Pairing row exists yet
// AND no CONFIRMED/PENDING row exists). Generates the missing round-robin pairs.
export async function simulateDivisionPairings(
  divisionId: string,
  rand: () => number,
): Promise<number> {
  const members = await prisma.divisionMember.findMany({
    where: { divisionId },
    include: { player: true },
  });
  const existing = await prisma.pairing.findMany({
    where: { divisionId },
    select: { playerAId: true, playerBId: true },
  });
  const playedSet = new Set(existing.map((p) => `${p.playerAId}-${p.playerBId}`));

  let played = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const p1 = members[i]!.player;
      const p2 = members[j]!.player;
      const [playerAId, playerBId] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
      if (playedSet.has(`${playerAId}-${playerBId}`)) continue;

      const result = randomResult(rand);
      const { a, b } = gamesFromResult(result);
      await prisma.pairing.create({
        data: {
          divisionId,
          playerAId,
          playerBId,
          gamesWonA: a,
          gamesWonB: b,
          status: "CONFIRMED",
          reportedAt: new Date(),
          confirmedAt: new Date(),
          adminOverrideBy: "mock-simulator",
          adminOverrideReason: "simulated pairing",
        },
      });
      played++;
    }
  }
  return played;
}

// Wipe every mock player + their division memberships + every pairing that references them.
// Returns count of players deleted.
export async function clearMockData(): Promise<number> {
  // Cascade rules in schema delete DivisionMember on player delete, but Pairing has
  // no cascade — clean those first.
  const mockPlayers = await prisma.player.findMany({
    where: { OR: MOCK_PREFIXES.map((prefix) => ({ discordId: { startsWith: prefix } })) },
    select: { id: true },
  });
  if (mockPlayers.length === 0) return 0;
  const ids = mockPlayers.map((p) => p.id);

  await prisma.pairing.deleteMany({
    where: { OR: [{ playerAId: { in: ids } }, { playerBId: { in: ids } }] },
  });
  await prisma.player.deleteMany({ where: { id: { in: ids } } });

  return mockPlayers.length;
}
