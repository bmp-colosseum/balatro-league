import "server-only";

// Data for /admin/avoided-pairs -- the "never pair these two players"
// blocklist. Row order and name resolution live here so the admin page and
// any other future caller (e.g. the scheduler) never re-derive it differently.
//
// AvoidedPair stores canonical ids (playerAId < playerBId, enforced by the
// server action, not the DB) -- readers here never re-sort them.

import { prisma } from "@/lib/prisma";
import { loadAllPlayersForPicker } from "@/lib/loaders/players";
import type { PlayerOption } from "@/components/PlayerSearch";

export interface AvoidedPairRow {
  id: string;
  playerAId: string;
  playerBId: string;
  aName: string;
  bName: string;
  note: string | null;
  createdAt: Date;
}

const UNKNOWN_NAME = "(unknown)";

// All blocked pairs, newest first, with both players' display names resolved
// in one batched query (no N+1 per row).
export async function loadAvoidedPairs(): Promise<AvoidedPairRow[]> {
  const pairs = await prisma.avoidedPair.findMany({
    orderBy: { createdAt: "desc" },
  });
  if (pairs.length === 0) return [];

  const ids = new Set<string>();
  for (const p of pairs) {
    ids.add(p.playerAId);
    ids.add(p.playerBId);
  }
  const players = await prisma.player.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));

  return pairs.map((p) => ({
    id: p.id,
    playerAId: p.playerAId,
    playerBId: p.playerBId,
    aName: nameById.get(p.playerAId) ?? UNKNOWN_NAME,
    bName: nameById.get(p.playerBId) ?? UNKNOWN_NAME,
    note: p.note,
    createdAt: p.createdAt,
  }));
}

// Lightweight canonical id-pair list -- consumed by the scheduler wiring
// (elsewhere) to exclude these matchups when a season's schedule is built.
export async function loadAvoidedPairIdPairs(): Promise<Array<[string, string]>> {
  const pairs = await prisma.avoidedPair.findMany({
    select: { playerAId: true, playerBId: true },
  });
  return pairs.map((p) => [p.playerAId, p.playerBId]);
}

// Every player, shaped for the <PlayerSearch> pickers on the add-pair form.
// Delegates to the shared picker loader so this list stays identical to every
// other "search a player" surface instead of re-querying separately.
export async function loadPlayersForPicker(): Promise<PlayerOption[]> {
  return loadAllPlayersForPicker();
}
