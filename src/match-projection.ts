// Projects a division's legacy Pairing + Shootout (+ MatchSession game JSON)
// into the unified Match / Game / Ban tables. Called from
// recomputeDivisionStandings, so every result write keeps the relational
// match model in sync — this is the transitional DUAL-WRITE of the
// expand/contract migration (removed at the contract stage, when Match
// becomes the source of truth written directly).
//
// Idempotent: Match reuses the source row's id; Game/Ban upsert on natural
// keys. Handles deletions — a Match whose source Pairing/Shootout is gone is
// removed (cascades its games/bans). Divisions are small, so re-projecting one
// on each recompute is cheap.

import { prisma } from "./db.js";

interface GameStateMin {
  firstId?: string;
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  dcByPlayerId?: string;
  bans?: number[];
  winnerId?: string;
  pickedRandomly?: boolean;
  firstBannedRandomly?: boolean;
  otherBannedRandomly?: boolean;
}

function deriveWinner(playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number): string | null {
  if (gamesWonA > gamesWonB) return playerAId;
  if (gamesWonB > gamesWonA) return playerBId;
  return null;
}

async function projectGame(
  matchId: string,
  num: number,
  playerAId: string,
  playerBId: string,
  json: string,
): Promise<void> {
  let g: GameStateMin;
  try {
    g = JSON.parse(json) as GameStateMin;
  } catch {
    return;
  }
  if (!g.firstId || !g.pool || g.pickedDeckIdx === undefined) return;
  const picked = g.pool[g.pickedDeckIdx];
  if (!picked) return;

  const firstId = g.firstId;
  const otherId = firstId === playerAId ? playerBId : playerAId;

  const game = await prisma.game.upsert({
    where: { matchId_num: { matchId, num } },
    create: {
      matchId,
      num,
      firstPlayerId: firstId,
      winnerId: g.winnerId ?? null,
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
      deck: picked.deck,
      stake: picked.stake,
      dcByPlayerId: g.dcByPlayerId ?? null,
      pickedRandomly: !!g.pickedRandomly,
      firstBannedRandomly: !!g.firstBannedRandomly,
      otherBannedRandomly: !!g.otherBannedRandomly,
    },
  });

  // Map each banned pool slot → its turn order, so we can attribute who
  // banned it (ordinal 0 / 4..6 = first player; 1..3 = the other).
  const banOrdinalByPoolIdx = new Map<number, number>();
  (g.bans ?? []).forEach((poolIdx, ordinal) => {
    if (poolIdx !== undefined) banOrdinalByPoolIdx.set(poolIdx, ordinal);
  });
  // Write the FULL pool (picked + banned + survivors).
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
}

export async function projectDivisionMatches(divisionId: string): Promise<void> {
  const pairings = await prisma.pairing.findMany({ where: { divisionId } });
  const shootouts = await prisma.shootout.findMany({ where: { divisionId } });

  // Remove Match rows whose source Pairing/Shootout no longer exists.
  const validIds = [...pairings.map((p) => p.id), ...shootouts.map((s) => s.id)];
  if (validIds.length === 0) {
    await prisma.match.deleteMany({ where: { divisionId } });
  } else {
    await prisma.match.deleteMany({ where: { divisionId, id: { notIn: validIds } } });
  }

  const sessions = await prisma.matchSession.findMany({
    where: { divisionId, pairingId: { not: null } },
    select: { pairingId: true, game1: true, game2: true, game3: true },
  });
  const sessionByPairing = new Map(sessions.map((s) => [s.pairingId!, s]));

  for (const p of pairings) {
    const fields = {
      divisionId: p.divisionId,
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
      winnerId: deriveWinner(p.playerAId, p.playerBId, p.gamesWonA, p.gamesWonB),
      status: p.status,
      reporterId: p.reporterId,
      reportedAt: p.reportedAt,
      confirmedAt: p.confirmedAt,
      adminOverrideBy: p.adminOverrideBy,
      adminOverrideReason: p.adminOverrideReason,
      reportChannelId: p.reportChannelId,
      reportMessageId: p.reportMessageId,
      disputedById: p.disputedById,
      disputeProposedGamesWonA: p.disputeProposedGamesWonA,
      disputeProposedGamesWonB: p.disputeProposedGamesWonB,
      disputeReason: p.disputeReason,
      disputedAt: p.disputedAt,
      disputeThreadId: p.disputeThreadId,
      hadDc: p.hadDc,
      reportedDeck: p.reportedDeck,
      reportedStake: p.reportedStake,
    };
    await prisma.match.upsert({
      where: { id: p.id },
      create: { id: p.id, format: "LEAGUE_BO2", ...fields },
      update: { format: "LEAGUE_BO2", ...fields },
    });
    const sess = sessionByPairing.get(p.id);
    if (sess) {
      if (sess.game1) await projectGame(p.id, 1, p.playerAId, p.playerBId, sess.game1);
      if (sess.game2) await projectGame(p.id, 2, p.playerAId, p.playerBId, sess.game2);
      if (sess.game3) await projectGame(p.id, 3, p.playerAId, p.playerBId, sess.game3);
    }
  }

  for (const s of shootouts) {
    const winA = s.winnerId === s.playerAId ? 1 : 0;
    const winB = s.winnerId === s.playerBId ? 1 : 0;
    const fields = {
      divisionId: s.divisionId,
      playerAId: s.playerAId,
      playerBId: s.playerBId,
      gamesWonA: winA,
      gamesWonB: winB,
      winnerId: s.winnerId,
      status: "CONFIRMED" as const,
      reportedAt: s.recordedAt,
      confirmedAt: s.recordedAt,
    };
    await prisma.match.upsert({
      where: { id: s.id },
      create: { id: s.id, format: "SHOOTOUT_BO1", ...fields },
      update: { format: "SHOOTOUT_BO1", ...fields },
    });
    if (s.game) await projectGame(s.id, 1, s.playerAId, s.playerBId, s.game);
  }
}
