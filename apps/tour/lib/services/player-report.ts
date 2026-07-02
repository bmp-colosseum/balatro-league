// Player-side set reporting with both-player confirmation (B6). A player reports
// their set from their own perspective ("my games – opponent's games"); the result
// sits as REPORTED until the OPPONENT confirms (→ CONFIRMED → matchup rollup →
// standings) or disputes (→ DISPUTED → a TO resolves via the admin report path).
//
// The actor is always the authenticated viewer's playerId (the caller passes it);
// every op verifies that player is actually in the set.
import { prisma } from "../db";
import { rollupMatchup } from "./report";
import { notifyLive } from "../notify";
import { isDeck, isStake } from "../balatro";

async function loadSetForPlayer(setId: string, playerId: string) {
  const set = await prisma.tourSet.findUnique({ where: { id: setId } });
  if (!set) throw new Error("No such set.");
  const isA = set.playerAId === playerId;
  const isB = set.playerBId === playerId;
  if (!isA && !isB) throw new Error("You're not a player in this set.");
  return { set, isA };
}

// Optional per-game detail captured at report time: each game's deck + stake and
// who won (from the REPORTER's perspective: "me" or "opp"). Powers deck/stake stats.
export interface GameInput {
  deck: string;
  stake: string;
  winner: "me" | "opp";
}

export async function playerReportSet(setId: string, playerId: string, myGames: number, oppGames: number, games?: GameInput[]) {
  const { set, isA } = await loadSetForPlayer(setId, playerId);

  // If per-game detail is given, it's the source of truth — derive the score from it.
  let mine = myGames;
  let opp = oppGames;
  const clean = (games ?? []).filter((g) => g && (g.deck || g.stake || g.winner));
  if (clean.length > 0) {
    for (const g of clean) {
      if (!isDeck(g.deck)) throw new Error(`Unknown deck "${g.deck}".`);
      if (!isStake(g.stake)) throw new Error(`Unknown stake "${g.stake}".`);
      if (g.winner !== "me" && g.winner !== "opp") throw new Error("Each game needs a winner.");
    }
    mine = clean.filter((g) => g.winner === "me").length;
    opp = clean.filter((g) => g.winner === "opp").length;
  }

  if (!Number.isInteger(mine) || !Number.isInteger(opp) || mine < 0 || opp < 0) throw new Error("Scores must be whole numbers ≥ 0.");
  if (mine === 0 && opp === 0) throw new Error("Enter the games each of you won.");

  // The reporter's perspective → team-A / team-B games (A = the set's playerA team).
  const gamesTeamA = isA ? mine : opp;
  const gamesTeamB = isA ? opp : mine;
  const a = set.playerAId;
  const b = set.playerBId;
  const swap = b < a; // core Match is canonical: playerA.id < playerB.id
  const winnerId = gamesTeamA > gamesTeamB ? a : gamesTeamB > gamesTeamA ? b : null;

  const data = {
    playerAId: swap ? b : a,
    playerBId: swap ? a : b,
    format: `BO${set.bestOf}`,
    gamesWonA: swap ? gamesTeamB : gamesTeamA,
    gamesWonB: swap ? gamesTeamA : gamesTeamB,
    winnerId,
    status: "PENDING" as const, // awaiting opponent confirm
    reporterId: playerId,
    reportedAt: new Date(),
    confirmedAt: null,
    disputedById: null,
    disputeReason: null,
  };

  let matchId = set.matchId;
  if (matchId) await prisma.match.update({ where: { id: matchId }, data });
  else matchId = (await prisma.match.create({ data })).id;

  // Replace any prior per-game rows with the freshly reported ones.
  await prisma.game.deleteMany({ where: { matchId } });
  if (clean.length > 0) {
    const oppId = isA ? set.playerBId : set.playerAId;
    for (let i = 0; i < clean.length; i++) {
      const g = clean[i]!;
      await prisma.game.create({
        data: { matchId, num: i + 1, firstPlayerId: playerId, deck: g.deck, stake: g.stake, winnerId: g.winner === "me" ? playerId : oppId },
      });
    }
  }

  await prisma.tourSet.update({ where: { id: setId }, data: { matchId, status: "REPORTED" } });
  // No matchup rollup yet — only a CONFIRMED set counts toward standings.
  await notifyLive("sets");
  if (set.matchupId) await notifyLive(`matchup:${set.matchupId}`);
  return { ok: true };
}

export async function playerConfirmSet(setId: string, playerId: string) {
  const { set } = await loadSetForPlayer(setId, playerId);
  if (set.status !== "REPORTED" || !set.matchId) throw new Error("There's nothing to confirm.");
  const m = await prisma.match.findUnique({ where: { id: set.matchId }, select: { reporterId: true } });
  if (m?.reporterId === playerId) throw new Error("You reported this set — your opponent confirms it.");
  await prisma.match.update({ where: { id: set.matchId }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
  await prisma.tourSet.update({ where: { id: setId }, data: { status: "CONFIRMED" } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
  return { ok: true };
}

export async function playerDisputeSet(setId: string, playerId: string, reason: string) {
  const { set } = await loadSetForPlayer(setId, playerId);
  if (set.status !== "REPORTED" || !set.matchId) throw new Error("There's nothing to dispute.");
  const m = await prisma.match.findUnique({ where: { id: set.matchId }, select: { reporterId: true } });
  if (m?.reporterId === playerId) throw new Error("You reported this set — re-report it instead of disputing.");
  await prisma.match.update({
    where: { id: set.matchId },
    data: { status: "DISPUTED", disputedById: playerId, disputeReason: reason.trim() || null, disputedAt: new Date() },
  });
  await prisma.tourSet.update({ where: { id: setId }, data: { status: "DISPUTED" } });
  await notifyLive("sets");
  if (set.matchupId) await notifyLive(`matchup:${set.matchupId}`);
  return { ok: true };
}
