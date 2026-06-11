// Direct writers for the unified Match model — used by the result-write
// paths (guided match completion, shootouts, seeds) to populate Game +
// GameDeck rows from a GameState, replacing the old MatchSession-JSON +
// projection approach.
//
// A Game carries the picked deck/stake + flags; its GameDeck rows are the
// FULL pool (one per combo) with picked/ban attribution, so deck/stake
// stats are exact SQL aggregates. Idempotent: upserts on (matchId,num) and
// (gameId,poolIdx).

import { prisma } from "./db.js";

export interface GameStateLike {
  firstId?: string;
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  dcByPlayerId?: string;
  bans?: number[];
  winnerId?: string;
  winnerLives?: number;
  pickedRandomly?: boolean;
  firstBannedRandomly?: boolean;
  otherBannedRandomly?: boolean;
}

// Write one game (+ its pool) onto a match. playerA/B are the match's
// canonical players, used to attribute bans (ordinal 0 / 4..6 = first
// player, 1..3 = the other). No-op if the game has no real pool/pick.
export async function writeMatchGame(
  matchId: string,
  num: number,
  playerAId: string,
  playerBId: string,
  g: GameStateLike,
): Promise<boolean> {
  if (!g.firstId || !g.pool || g.pickedDeckIdx === undefined) return false;
  const picked = g.pool[g.pickedDeckIdx];
  if (!picked) return false;

  const firstId = g.firstId;
  const otherId = firstId === playerAId ? playerBId : playerAId;

  const game = await prisma.game.upsert({
    where: { matchId_num: { matchId, num } },
    create: {
      matchId,
      num,
      firstPlayerId: firstId,
      winnerId: g.winnerId ?? null,
      winnerLives: g.winnerLives ?? null,
      deck: picked.deck,
      stake: picked.stake,
      dcByPlayerId: g.dcByPlayerId ?? null,
      pickedRandomly: !!g.pickedRandomly,
      firstBannedRandomly: !!g.firstBannedRandomly,
      otherBannedRandomly: !!g.otherBannedRandomly,
    },
    update: {
      firstPlayerId: firstId,
      winnerId: g.winnerId ?? null,
      winnerLives: g.winnerLives ?? null,
      deck: picked.deck,
      stake: picked.stake,
      dcByPlayerId: g.dcByPlayerId ?? null,
      pickedRandomly: !!g.pickedRandomly,
      firstBannedRandomly: !!g.firstBannedRandomly,
      otherBannedRandomly: !!g.otherBannedRandomly,
    },
  });

  const banOrdinalByPoolIdx = new Map<number, number>();
  (g.bans ?? []).forEach((poolIdx, ordinal) => {
    if (poolIdx !== undefined) banOrdinalByPoolIdx.set(poolIdx, ordinal);
  });
  for (let poolIdx = 0; poolIdx < g.pool.length; poolIdx++) {
    const combo = g.pool[poolIdx];
    if (!combo) continue;
    const banOrdinal = banOrdinalByPoolIdx.get(poolIdx);
    const bannedById =
      banOrdinal === undefined ? null : banOrdinal === 0 || banOrdinal >= 4 ? firstId : otherId;
    await prisma.gameDeck.upsert({
      where: { gameId_poolIdx: { gameId: game.id, poolIdx } },
      create: {
        gameId: game.id,
        poolIdx,
        deck: combo.deck,
        stake: combo.stake,
        picked: poolIdx === g.pickedDeckIdx,
        banOrdinal: banOrdinal ?? null,
        bannedById,
      },
      update: {
        deck: combo.deck,
        stake: combo.stake,
        picked: poolIdx === g.pickedDeckIdx,
        banOrdinal: banOrdinal ?? null,
        bannedById,
      },
    });
  }
  return true;
}

// Write a series' games (BO2/BO3) onto a match from its per-game states.
export async function writeMatchGames(
  matchId: string,
  playerAId: string,
  playerBId: string,
  games: Array<GameStateLike | null | undefined>,
): Promise<void> {
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (g) await writeMatchGame(matchId, i + 1, playerAId, playerBId, g);
  }
}
