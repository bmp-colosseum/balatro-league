// Result reporting service (B6). A set's per-game score is entered (admin
// authority → CONFIRMED for now; the both-players-confirm flow lands with captain
// auth), which writes a canonical core Match and links it to the TourSet. The
// matchup's team result is rolled up ONLY once it's decided (a team reaches
// setsToWin, or every set is in) — so derive-on-read standings count only
// completed matchups, exactly like the imported team-only seasons.
import { prisma } from "../db";
import { notifyLive } from "../notify";
import { enqueueAnnounceResult, enqueueAnnounceMatchup } from "../queue";

export async function reportSet(setId: string, gamesTeamA: number, gamesTeamB: number) {
  const set = await prisma.tourSet.findUnique({ where: { id: setId } });
  if (!set) throw new Error("No such set.");
  if (!Number.isInteger(gamesTeamA) || !Number.isInteger(gamesTeamB) || gamesTeamA < 0 || gamesTeamB < 0) {
    throw new Error("Scores must be whole numbers ≥ 0.");
  }
  if (gamesTeamA === 0 && gamesTeamB === 0) throw new Error("Enter at least one game won.");

  const a = set.playerAId; // team A's player
  const b = set.playerBId; // team B's player
  // Core Match is canonical: playerA.id < playerB.id. Map the team scores onto it.
  const swap = b < a;
  const winnerId = gamesTeamA > gamesTeamB ? a : gamesTeamB > gamesTeamA ? b : null;

  const data = {
    playerAId: swap ? b : a,
    playerBId: swap ? a : b,
    format: `BO${set.bestOf}`,
    gamesWonA: swap ? gamesTeamB : gamesTeamA,
    gamesWonB: swap ? gamesTeamA : gamesTeamB,
    winnerId,
    status: "CONFIRMED" as const,
    confirmedAt: new Date(),
  };

  let matchId = set.matchId;
  if (matchId) {
    await prisma.match.update({ where: { id: matchId }, data });
  } else {
    const m = await prisma.match.create({ data });
    matchId = m.id;
  }
  await prisma.tourSet.update({ where: { id: setId }, data: { matchId, status: "CONFIRMED" } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
  await enqueueAnnounceResult(setId);
  return { ok: true };
}

// TO assigns a forfeit (rules: a 0–2 set loss for no reasonable scheduling effort).
// The forfeiting team gets 0; the other takes the set by the majority game count.
export async function forfeitSet(setId: string, forfeitTeam: "A" | "B") {
  const set = await prisma.tourSet.findUnique({ where: { id: setId } });
  if (!set) throw new Error("No such set.");
  const win = Math.max(1, Math.ceil(set.bestOf / 2)); // 2 for BO3
  const gamesTeamA = forfeitTeam === "A" ? 0 : win;
  const gamesTeamB = forfeitTeam === "B" ? 0 : win;
  const a = set.playerAId;
  const b = set.playerBId;
  const swap = b < a;
  const winnerId = gamesTeamA > gamesTeamB ? a : b;
  const data = {
    playerAId: swap ? b : a,
    playerBId: swap ? a : b,
    format: `BO${set.bestOf}`,
    gamesWonA: swap ? gamesTeamB : gamesTeamA,
    gamesWonB: swap ? gamesTeamA : gamesTeamB,
    winnerId,
    status: "CONFIRMED" as const,
    forfeit: true,
    confirmedAt: new Date(),
  };
  let matchId = set.matchId;
  if (matchId) await prisma.match.update({ where: { id: matchId }, data });
  else matchId = (await prisma.match.create({ data })).id;
  await prisma.tourSet.update({ where: { id: setId }, data: { matchId, status: "FORFEIT" } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
  await enqueueAnnounceResult(setId);
  return { ok: true };
}

// Double DQ: NOBODY played the set and it doesn't matter (rules: both sides no-show).
// Records a 0-0 with no winner -- the set counts as accounted-for (so the matchup can
// complete and stops looking short in the grid/audit) but awards no set or game to
// either team. Distinct from forfeitSet, where one side takes the set.
export async function dqSet(setId: string) {
  const set = await prisma.tourSet.findUnique({ where: { id: setId } });
  if (!set) throw new Error("No such set.");
  const a = set.playerAId;
  const b = set.playerBId;
  const swap = b < a;
  const data = {
    playerAId: swap ? b : a,
    playerBId: swap ? a : b,
    format: `BO${set.bestOf}`,
    gamesWonA: 0,
    gamesWonB: 0,
    winnerId: null,
    status: "CONFIRMED" as const,
    forfeit: true,
    confirmedAt: new Date(),
  };
  let matchId = set.matchId;
  if (matchId) await prisma.match.update({ where: { id: matchId }, data });
  else matchId = (await prisma.match.create({ data })).id;
  await prisma.tourSet.update({ where: { id: setId }, data: { matchId, status: "FORFEIT" } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
  return { ok: true };
}

// Undo a report: drop the Match, unlink the set, recompute the matchup.
export async function unreportSet(setId: string) {
  const set = await prisma.tourSet.findUnique({ where: { id: setId } });
  if (!set) throw new Error("No such set.");
  if (set.matchId) await prisma.match.delete({ where: { id: set.matchId } });
  await prisma.tourSet.update({ where: { id: setId }, data: { matchId: null, status: "PROPOSED" } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
}

// Recompute the matchup's team result from its CONFIRMED sets. Persists it only
// when the matchup is decided; otherwise clears it so standings ignore the
// in-progress matchup (derive-on-read counts only completed matchups).
export async function rollupMatchup(matchupId: string) {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { week: { include: { season: { select: { setsToWin: true } } } }, sets: true },
  });
  if (!matchup) return;
  const setsToWin = matchup.week.season.setsToWin;

  const matchIds = matchup.sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const matches = await prisma.match.findMany({
    where: { id: { in: matchIds } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const mById = new Map(matches.map((m) => [m.id, m]));

  let setsA = 0, setsB = 0, gamesA = 0, gamesB = 0, confirmed = 0;
  for (const s of matchup.sets) {
    if ((s.status !== "CONFIRMED" && s.status !== "FORFEIT") || !s.matchId) continue;
    const m = mById.get(s.matchId);
    if (!m) continue;
    confirmed++;
    gamesA += m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB;
    gamesB += m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA;
    if (m.winnerId === s.playerAId) setsA++;
    else if (m.winnerId === s.playerBId) setsB++;
  }

  const total = matchup.sets.length;
  const decided = setsA >= setsToWin || setsB >= setsToWin || (total > 0 && confirmed === total);
  if (decided) {
    const winnerTeamSeasonId = setsA > setsB ? matchup.teamSeasonAId : setsB > setsA ? matchup.teamSeasonBId : null;
    // Only announce the team-result banner the FIRST time it becomes decided.
    const wasDecided = matchup.setsWonA != null && matchup.setsWonB != null;
    await prisma.matchup.update({
      where: { id: matchupId },
      data: { setsWonA: setsA, setsWonB: setsB, gamesWonA: gamesA, gamesWonB: gamesB, winnerTeamSeasonId },
    });
    if (!wasDecided) await enqueueAnnounceMatchup(matchupId);
  } else {
    await prisma.matchup.update({
      where: { id: matchupId },
      data: { setsWonA: null, setsWonB: null, gamesWonA: null, gamesWonB: null, winnerTeamSeasonId: null },
    });
  }
  // Live refresh (C5): every confirmed/forfeit/unreport path funnels through this rollup.
  await notifyLive(`matchup:${matchupId}`);
  await notifyLive("sets");
}

// Per-set results view for the matchup console: each set's score + winner, plus
// the rolled-up team result (decided or the running tally).
export async function getMatchupReport(matchupId: string) {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { week: { include: { season: { select: { setsToWin: true } } } }, sets: { orderBy: { seedA: "asc" } } },
  });
  if (!matchup) return null;

  const matchIds = matchup.sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const playerIds = [...new Set(matchup.sets.flatMap((s) => [s.playerAId, s.playerBId, s.reassignedFromId].filter((x): x is string => !!x)))];
  const [matches, players, teamSeasons] = await Promise.all([
    prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: [matchup.teamSeasonAId, matchup.teamSeasonBId] } }, include: { team: true } }),
  ]);
  const mById = new Map(matches.map((m) => [m.id, m]));
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const teamName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));

  let liveA = 0, liveB = 0;
  const sets = matchup.sets.map((s) => {
    const m = s.matchId ? mById.get(s.matchId) : undefined;
    const teamAGames = m ? (m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB) : null;
    const teamBGames = m ? (m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA) : null;
    const winner = m?.winnerId === s.playerAId ? "A" : m?.winnerId === s.playerBId ? "B" : null;
    if (s.status === "CONFIRMED" && winner === "A") liveA++;
    if (s.status === "CONFIRMED" && winner === "B") liveB++;
    return {
      setId: s.id,
      aName: nameOf.get(s.playerAId) ?? s.playerAId,
      bName: nameOf.get(s.playerBId) ?? s.playerBId,
      aPlayerId: s.playerAId,
      bPlayerId: s.playerBId,
      aSeed: s.seedA,
      bSeed: s.seedB,
      bestOf: s.bestOf,
      status: s.status,
      reported: s.status === "CONFIRMED" || s.status === "FORFEIT",
      played: s.status === "CONFIRMED" || s.status === "FORFEIT" || s.status === "REPORTED",
      reassignedFrom: s.reassignedFromId ? nameOf.get(s.reassignedFromId) ?? null : null,
      teamAGames,
      teamBGames,
      winner,
    };
  });

  return {
    matchupId,
    teamAName: teamName.get(matchup.teamSeasonAId) ?? "Team A",
    teamBName: teamName.get(matchup.teamSeasonBId) ?? "Team B",
    teamASeasonId: matchup.teamSeasonAId,
    teamBSeasonId: matchup.teamSeasonBId,
    setsToWin: matchup.week.season.setsToWin,
    decided: matchup.setsWonA != null,
    setsWonA: matchup.setsWonA ?? liveA,
    setsWonB: matchup.setsWonB ?? liveB,
    winnerTeamSeasonId: matchup.winnerTeamSeasonId,
    winnerTeamName: matchup.winnerTeamSeasonId ? teamName.get(matchup.winnerTeamSeasonId) ?? null : null,
    sets,
  };
}
