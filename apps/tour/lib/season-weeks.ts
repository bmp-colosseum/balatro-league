// Week-by-week read model for a season — derived purely from the imported result sets
// (TourSet carries week + the team each player played for). Steps through each week's
// team matchups + the player sets within them, and surfaces mid-season roster moves
// (a player whose first appearance is after the opening week = an add/sub). No writes.
import { prisma } from "./db";
import { seedAtWeekResolver } from "./services/roster-ops";

export interface WeekSet {
  playerA: string;
  playerAId: string;
  playerB: string;
  playerBId: string;
  seedA: number | null;  // effective seed that week (folds re-seeds)
  seedB: number | null;
  scoreA: number;
  scoreB: number;
}
export interface WeekMatchup {
  teamA: string;
  teamAId: string;
  teamB: string;
  teamBId: string;
  setsA: number;
  setsB: number;
  sets: WeekSet[];
}
export interface WeekMove {
  team: string;
  teamSeasonId: string;
  player: string;
  playerId: string;
  drafted: boolean; // false = a true outside sub/add; true = a drafted player debuting late
}
export interface SeasonWeek {
  week: number;
  matchups: WeekMatchup[];
  moves: WeekMove[];
}

export async function getSeasonWeeks(seasonName: string): Promise<SeasonWeek[]> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return [];
  const sets = await prisma.tourSet.findMany({
    where: { seasonId: season.id, bracket: "REGULAR", week: { not: null }, teamSeasonAId: { not: null }, teamSeasonBId: { not: null } },
    select: { week: true, teamSeasonAId: true, teamSeasonBId: true, playerAId: true, playerBId: true, matchId: true },
  });
  if (!sets.length) return [];

  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const tsIds = [...new Set(sets.flatMap((s) => [s.teamSeasonAId!, s.teamSeasonBId!]))];
  const playerIds = [...new Set(sets.flatMap((s) => [s.playerAId, s.playerBId]))];
  const [matches, tss, players, picks] = await Promise.all([
    prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } }),
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } }),
    prisma.draftPick.findMany({ where: { teamSeasonId: { in: tsIds } }, select: { teamSeasonId: true, playerId: true } }),
  ]);
  const seedAt = await seedAtWeekResolver(tsIds);
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const teamName = new Map(tss.map((t) => [t.id, t.team.name]));
  const captainOf = new Map(tss.map((t) => [t.id, t.captainPlayerId]));
  const pName = new Map(players.map((p) => [p.id, p.displayName]));
  const draftedByTeam = new Map<string, Set<string>>();
  for (const p of picks) {
    if (!p.playerId) continue;
    (draftedByTeam.get(p.teamSeasonId) ?? draftedByTeam.set(p.teamSeasonId, new Set()).get(p.teamSeasonId)!).add(p.playerId);
  }

  // First week each (team, player) appears — for mid-season add/sub detection.
  const firstWeek = new Map<string, number>(); // `${teamId}|${playerId}` -> earliest week
  const seenWeek = (tsId: string, pid: string, wk: number) => {
    const k = `${tsId}|${pid}`;
    const cur = firstWeek.get(k);
    if (cur == null || wk < cur) firstWeek.set(k, wk);
  };
  let openingWeek = Infinity;
  for (const s of sets) {
    seenWeek(s.teamSeasonAId!, s.playerAId, s.week!);
    seenWeek(s.teamSeasonBId!, s.playerBId, s.week!);
    if (s.week! < openingWeek) openingWeek = s.week!;
  }

  // Group sets by week → team matchup (playerA is on teamA, playerB on teamB — consistent
  // per matchup from the import).
  const byWeek = new Map<number, Map<string, WeekMatchup>>();
  for (const s of sets) {
    const m = s.matchId ? matchById.get(s.matchId) : undefined;
    if (!m) continue;
    const gA = m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB;
    const gB = m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA;
    const wm = byWeek.get(s.week!) ?? byWeek.set(s.week!, new Map()).get(s.week!)!;
    // Group by the UNORDERED team pair — a cross-conference game is listed in both tabs with
    // opposite team order, so a stable key keeps it one matchup instead of splitting it. Then
    // orient each set so playerA is on the matchup's teamA (t0).
    const aTs = s.teamSeasonAId!, bTs = s.teamSeasonBId!;
    const [t0, t1] = aTs < bTs ? [aTs, bTs] : [bTs, aTs];
    const key = `${t0}|${t1}`;
    let mu = wm.get(key);
    if (!mu) {
      mu = { teamA: teamName.get(t0) ?? "?", teamAId: t0, teamB: teamName.get(t1) ?? "?", teamBId: t1, setsA: 0, setsB: 0, sets: [] };
      wm.set(key, mu);
    }
    const flip = aTs !== t0; // this set's playerA is on aTs; flip if aTs is the matchup's teamB
    const p0Id = flip ? s.playerBId : s.playerAId;
    const p1Id = flip ? s.playerAId : s.playerBId;
    mu.sets.push({
      playerA: pName.get(p0Id) ?? "?",
      playerAId: p0Id,
      playerB: pName.get(p1Id) ?? "?",
      playerBId: p1Id,
      seedA: seedAt(t0, s.week!, p0Id),
      seedB: seedAt(t1, s.week!, p1Id),
      scoreA: flip ? gB : gA,
      scoreB: flip ? gA : gB,
    });
    if (m.winnerId === p0Id) mu.setsA++;
    else if (m.winnerId === p1Id) mu.setsB++;
  }

  // Moves: a (team, player) whose first week is after the opening week.
  const movesByWeek = new Map<number, WeekMove[]>();
  for (const [k, wk] of firstWeek) {
    if (wk <= openingWeek) continue;
    const [tsId, pid] = k.split("|");
    if (captainOf.get(tsId) === pid) continue; // captain isn't an add
    (movesByWeek.get(wk) ?? movesByWeek.set(wk, []).get(wk)!).push({
      team: teamName.get(tsId) ?? "?",
      teamSeasonId: tsId,
      player: pName.get(pid) ?? "?",
      playerId: pid,
      drafted: draftedByTeam.get(tsId)?.has(pid) ?? false,
    });
  }

  // Sets within a matchup always run seed 1 first (by teamA's seed, then teamB's).
  const bySeed = (a: WeekSet, b: WeekSet) => (a.seedA ?? 99) - (b.seedA ?? 99) || (a.seedB ?? 99) - (b.seedB ?? 99);
  for (const wm of byWeek.values()) for (const mu of wm.values()) mu.sets.sort(bySeed);

  return [...byWeek.keys()]
    .sort((a, b) => a - b)
    .map((week) => ({
      week,
      matchups: [...byWeek.get(week)!.values()].sort((a, b) => a.teamA.localeCompare(b.teamA)),
      moves: (movesByWeek.get(week) ?? []).sort((a, b) => a.team.localeCompare(b.team)),
    }));
}
