// Pick'em — per-set predictions by any signed-in user. A set is "open" for picks until it's
// decided (its Match has a winner); then the pick locks and scores +1 if correct. Correctness
// is derived on read (pickedPlayerId == the set's winner). Leaderboards (season + all-time)
// rank predictors by correct picks, then accuracy. Centralized service; page/actions call in.
import { prisma } from "../db";

export interface PickSet {
  setId: string;
  week: number | null;
  playerAId: string;
  playerA: string;
  playerBId: string;
  playerB: string;
  teamAId: string | null;
  teamA: string | null;
  teamBId: string | null;
  teamB: string | null;
  decided: boolean;
  winnerId: string | null;
  myPick: string | null; // the viewer's picked playerId, if any
}
export interface PickWeek {
  week: number;
  sets: PickSet[];
}
export interface SeasonPickem {
  seasonId: string;
  weeks: PickWeek[];
  openCount: number;
}

async function seasonIdOf(name: string): Promise<string | null> {
  const s = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  return s?.id ?? null;
}

// A set's winner (via its Match), for a batch of sets.
async function winnersForSets(sets: { id: string; matchId: string | null }[]): Promise<Map<string, string | null>> {
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const matches = matchIds.length
    ? await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, winnerId: true } })
    : [];
  const winnerByMatch = new Map(matches.map((m) => [m.id, m.winnerId]));
  const out = new Map<string, string | null>();
  for (const s of sets) out.set(s.id, s.matchId ? winnerByMatch.get(s.matchId) ?? null : null);
  return out;
}

export async function getSeasonPickem(seasonName: string, viewerDiscordId?: string | null): Promise<SeasonPickem | null> {
  const seasonId = await seasonIdOf(seasonName);
  if (!seasonId) return null;

  const sets = await prisma.tourSet.findMany({
    where: { seasonId },
    select: { id: true, week: true, playerAId: true, playerBId: true, matchId: true, teamSeasonAId: true, teamSeasonBId: true },
    orderBy: [{ week: "asc" }],
  });
  const winnerBySet = await winnersForSets(sets);

  const pids = [...new Set(sets.flatMap((s) => [s.playerAId, s.playerBId]))];
  const tsIds = [...new Set(sets.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId]).filter((x): x is string => !!x))];
  const [players, teamSeasons, myPicks] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } }),
    viewerDiscordId
      ? prisma.prediction.findMany({ where: { seasonId, predictorDiscordId: viewerDiscordId }, select: { setId: true, pickedPlayerId: true } })
      : Promise.resolve([]),
  ]);
  const pName = new Map(players.map((p) => [p.id, p.displayName]));
  const tName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const myBySet = new Map(myPicks.map((p) => [p.setId, p.pickedPlayerId]));

  const byWeek = new Map<number, PickSet[]>();
  let openCount = 0;
  for (const s of sets) {
    const winnerId = winnerBySet.get(s.id) ?? null;
    const decided = winnerId != null;
    if (!decided) openCount++;
    const wk = s.week ?? 0;
    const row: PickSet = {
      setId: s.id,
      week: s.week,
      playerAId: s.playerAId,
      playerA: pName.get(s.playerAId) ?? "?",
      playerBId: s.playerBId,
      playerB: pName.get(s.playerBId) ?? "?",
      teamAId: s.teamSeasonAId,
      teamA: s.teamSeasonAId ? tName.get(s.teamSeasonAId) ?? null : null,
      teamBId: s.teamSeasonBId,
      teamB: s.teamSeasonBId ? tName.get(s.teamSeasonBId) ?? null : null,
      decided,
      winnerId,
      myPick: myBySet.get(s.id) ?? null,
    };
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(row);
  }
  const weeks: PickWeek[] = [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, s]) => ({ week, sets: s }));
  return { seasonId, weeks, openCount };
}

// Record/replace a viewer's pick for a set. Only while the set is still open.
export async function makePick(discordId: string, name: string | null, setId: string, pickedPlayerId: string): Promise<void> {
  const set = await prisma.tourSet.findUnique({ where: { id: setId }, select: { id: true, seasonId: true, playerAId: true, playerBId: true, matchId: true } });
  if (!set) throw new Error("No such set.");
  if (pickedPlayerId !== set.playerAId && pickedPlayerId !== set.playerBId) throw new Error("Pick must be one of the two players.");
  if (set.matchId) {
    const m = await prisma.match.findUnique({ where: { id: set.matchId }, select: { winnerId: true } });
    if (m?.winnerId) throw new Error("That set is already decided.");
  }
  await prisma.prediction.upsert({
    where: { predictorDiscordId_setId: { predictorDiscordId: discordId, setId } },
    create: { seasonId: set.seasonId ?? "", setId, predictorDiscordId: discordId, predictorName: name, pickedPlayerId },
    update: { pickedPlayerId, predictorName: name },
  });
}

export interface PickemLeaderRow {
  discordId: string;
  name: string;
  correct: number;
  decided: number; // scored (decided) picks
  pct: number; // 0..100 over decided picks
}

// Leaderboard by correct picks then accuracy. Season-scoped when seasonName is given, else all-time.
export async function pickemLeaderboard(seasonName?: string): Promise<PickemLeaderRow[]> {
  let where = {};
  if (seasonName) {
    const sid = await seasonIdOf(seasonName);
    if (!sid) return [];
    where = { seasonId: sid };
  }
  const preds = await prisma.prediction.findMany({ where, select: { predictorDiscordId: true, predictorName: true, setId: true, pickedPlayerId: true } });
  if (!preds.length) return [];
  const setIds = [...new Set(preds.map((p) => p.setId))];
  const sets = await prisma.tourSet.findMany({ where: { id: { in: setIds } }, select: { id: true, matchId: true } });
  const winnerBySet = await winnersForSets(sets);

  const agg = new Map<string, { name: string; correct: number; decided: number }>();
  for (const p of preds) {
    const winner = winnerBySet.get(p.setId) ?? null;
    if (winner == null) continue; // undecided picks don't score yet
    const a = agg.get(p.predictorDiscordId) ?? { name: p.predictorName ?? p.predictorDiscordId, correct: 0, decided: 0 };
    a.decided++;
    if (p.pickedPlayerId === winner) a.correct++;
    if (p.predictorName) a.name = p.predictorName;
    agg.set(p.predictorDiscordId, a);
  }
  return [...agg.entries()]
    .map(([discordId, a]) => ({ discordId, name: a.name, correct: a.correct, decided: a.decided, pct: a.decided ? (100 * a.correct) / a.decided : 0 }))
    .sort((x, y) => y.correct - x.correct || y.pct - x.pct);
}
