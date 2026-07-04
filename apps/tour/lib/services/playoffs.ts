// Playoffs service (B8). Qualifies the field from live standings (competition-core
// qualify + seedField), persists PlayoffEntry seeds + the round-1 bracket
// (standardBracketPairings), then runs the series — each reported result advances
// winners into the next round (advanceWinners) until a champion falls out of the
// FINAL. The qualify/seed path is the same one getPlayoffPicture renders as a
// projection; this is its write side. Single-elim, field of 2/4/8.
import { qualify, seedField, standardBracketPairings, advanceWinners, type StandingRow } from "@balatro/competition-core";
import { getSeasonStandings } from "../standings";
import { prisma } from "../db";
import { notifyLive } from "../notify";

type Round = "QUARTERFINAL" | "SEMIFINAL" | "FINAL";
const ROUND_BY_SIZE: Record<number, Round> = { 8: "QUARTERFINAL", 4: "SEMIFINAL", 2: "FINAL" };
const NEXT_ROUND: Record<Round, Round | null> = { QUARTERFINAL: "SEMIFINAL", SEMIFINAL: "FINAL", FINAL: null };
const ROUND_ORDER: Record<Round, number> = { QUARTERFINAL: 0, SEMIFINAL: 1, FINAL: 2 };
const ROUND_LABEL: Record<Round, string> = { QUARTERFINAL: "Quarterfinals", SEMIFINAL: "Semifinals", FINAL: "Final" };

const pct = (w: number, l: number) => (w + l ? w / (w + l) : 0);
const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0;

// Qualify + seed the field from the season's standings (same logic as
// getPlayoffPicture, returning raw ids/seeds for persistence).
async function computeSeededField(seasonName: string) {
  const s = await getSeasonStandings(seasonName);
  if (!s) return null;

  const nameById = new Map<string, string>();
  const confById = new Map<string, string>();
  const byGroup = new Map<string, StandingRow[]>();
  const overall: { id: string; m: number; se: number; g: number }[] = [];

  for (const grp of s.groups) {
    const rows: StandingRow[] = grp.rows.map((r) => {
      nameById.set(r.teamSeasonId, r.name);
      confById.set(r.teamSeasonId, grp.conferenceName);
      overall.push({ id: r.teamSeasonId, m: pct(r.matchupsW, r.matchupsL), se: pct(r.setsW, r.setsL), g: pct(r.gamesW, r.gamesL) });
      return { participantId: r.teamSeasonId, groupId: grp.conferenceId, wins: 0, losses: 0, draws: 0, points: 0, metrics: {} };
    });
    byGroup.set(grp.conferenceId, rows);
  }

  const overallRanked = overall.sort((a, b) => b.m - a.m || b.se - a.se || b.g - a.g).map((r) => r.id);
  const perGroup = s.groups.length >= 2 ? Math.max(1, Math.floor(s.playoffTeams / s.groups.length)) : s.playoffTeams;
  const field = qualify({ byGroup, overallRanked, perGroup, fieldSize: s.playoffTeams });
  const seeded = seedField(field, overallRanked);
  const wildcardOf = new Map(field.map((f) => [f.participantId, f.viaWildcard]));

  return {
    playoffTeams: s.playoffTeams,
    valid: isPow2(seeded.length) && seeded.length in ROUND_BY_SIZE,
    seeded: seeded.map((id, i) => ({
      teamSeasonId: id,
      seed: i + 1,
      viaWildcard: wildcardOf.get(id) ?? false,
      conference: confById.get(id) ?? "",
      name: nameById.get(id) ?? id,
    })),
  };
}

export async function startPlayoffs(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if ((await prisma.playoffEntry.count({ where: { seasonId: season.id } })) > 0) {
    throw new Error("Playoffs already started — reset first.");
  }
  const field = await computeSeededField(seasonName);
  if (!field) throw new Error("No standings for this season yet.");
  if (!field.valid) throw new Error(`Need a 2/4/8-team field — standings produced ${field.seeded.length} qualifiers.`);

  await prisma.playoffEntry.createMany({
    data: field.seeded.map((q) => ({ seasonId: season.id, teamSeasonId: q.teamSeasonId, seed: q.seed, viaWildcard: q.viaWildcard })),
  });

  const seededIds = field.seeded.map((q) => q.teamSeasonId);
  const round = ROUND_BY_SIZE[field.seeded.length]!;
  const pairs = standardBracketPairings(seededIds);
  await prisma.playoffSeries.createMany({
    data: pairs.map(([a, b], i) => ({ seasonId: season.id, round, bracketIndex: i, teamSeasonAId: a, teamSeasonBId: b })),
  });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "PLAYOFFS" } });
  return { field: field.seeded.length, round };
}

export async function reportSeries(seriesId: string, scoreA: number, scoreB: number) {
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    throw new Error("Scores must be whole numbers ≥ 0.");
  }
  if (scoreA === scoreB) throw new Error("A playoff series needs a winner (no ties).");
  const series = await prisma.playoffSeries.findUnique({ where: { id: seriesId } });
  if (!series) throw new Error("No such series.");
  const winnerTeamSeasonId = scoreA > scoreB ? series.teamSeasonAId : series.teamSeasonBId;
  await prisma.playoffSeries.update({ where: { id: seriesId }, data: { scoreA, scoreB, winnerTeamSeasonId } });
  await maybeAdvance(series.seasonId, series.round as Round);
  // Live-refresh any open series scoreboard overlay (OBS browser source).
  await notifyLive(`series:${seriesId}`);
  return { champion: series.round === "FINAL" };
}

// When every series in a round has a winner, build the next round from the winners
// (in bracket order). No-op past the FINAL or if the next round already exists.
async function maybeAdvance(seasonId: string, round: Round) {
  const next = NEXT_ROUND[round];
  if (!next) return;
  const roundSeries = await prisma.playoffSeries.findMany({ where: { seasonId, round }, orderBy: { bracketIndex: "asc" } });
  if (roundSeries.length === 0 || roundSeries.some((s) => !s.winnerTeamSeasonId)) return;
  if ((await prisma.playoffSeries.count({ where: { seasonId, round: next } })) > 0) return;

  const winners = roundSeries.map((s) => s.winnerTeamSeasonId!).filter((x): x is string => !!x);
  const pairs = advanceWinners(winners);
  await prisma.playoffSeries.createMany({
    data: pairs.map(([a, b], i) => ({ seasonId, round: next, bracketIndex: i, teamSeasonAId: a, teamSeasonBId: b })),
  });
}

export async function resetPlayoffs(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  await prisma.playoffSeries.deleteMany({ where: { seasonId: season.id } });
  await prisma.playoffEntry.deleteMany({ where: { seasonId: season.id } });
  await prisma.championship.deleteMany({ where: { seasonId: season.id } });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "REGULAR" } });
}

// Admin view: projected field before start, or the live bracket (rounds + series +
// champion) once started.
export async function getPlayoffAdmin(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, state: true } });
  if (!season) return null;

  const entries = await prisma.playoffEntry.findMany({ where: { seasonId: season.id }, orderBy: { seed: "asc" } });
  if (entries.length === 0) {
    const field = await computeSeededField(seasonName);
    const pairings =
      field && field.valid
        ? standardBracketPairings(field.seeded.map((q) => q.teamSeasonId)).map(([a, b]) => {
            const A = field.seeded.find((q) => q.teamSeasonId === a)!;
            const B = field.seeded.find((q) => q.teamSeasonId === b)!;
            return { a: `#${A.seed} ${A.name}`, b: `#${B.seed} ${B.name}` };
          })
        : [];
    return { started: false as const, seasonState: season.state, projected: field, pairings };
  }

  const series = await prisma.playoffSeries.findMany({
    where: { seasonId: season.id },
    orderBy: [{ bracketIndex: "asc" }],
  });
  const tsIds = [...new Set([...entries.map((e) => e.teamSeasonId), ...series.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId])].filter((x): x is string => !!x))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const nameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));
  const label = (id: string | null) => (id ? `#${seedOf.get(id) ?? "?"} ${nameOf.get(id) ?? id}` : "—");

  const byRound = new Map<Round, typeof series>();
  for (const s of series) {
    const arr = byRound.get(s.round as Round) ?? [];
    arr.push(s);
    byRound.set(s.round as Round, arr);
  }
  const rounds = [...byRound.entries()]
    .sort((a, b) => ROUND_ORDER[a[0]] - ROUND_ORDER[b[0]])
    .map(([round, ss]) => ({
      round,
      label: ROUND_LABEL[round],
      series: ss
        .sort((a, b) => a.bracketIndex - b.bracketIndex)
        .map((s) => ({
          id: s.id,
          aId: s.teamSeasonAId,
          bId: s.teamSeasonBId,
          aLabel: label(s.teamSeasonAId),
          bLabel: label(s.teamSeasonBId),
          scoreA: s.scoreA,
          scoreB: s.scoreB,
          winnerLabel: s.winnerTeamSeasonId ? label(s.winnerTeamSeasonId) : null,
          decided: !!s.winnerTeamSeasonId,
        })),
    }));

  const finalS = series.find((s) => s.round === "FINAL");
  const champion = finalS?.winnerTeamSeasonId ? label(finalS.winnerTeamSeasonId) : null;

  return {
    started: true as const,
    seasonState: season.state,
    entries: entries.map((e) => ({ seed: e.seed, name: nameOf.get(e.teamSeasonId) ?? e.teamSeasonId, viaWildcard: e.viaWildcard })),
    rounds,
    champion,
  };
}

// One playoff series, trimmed for the scoreboard overlay: team names + seeds + the TO-entered
// series score + round + winner. Live-updates via the `series:<id>` scope (reportSeries notifies).
export async function getSeriesReport(seriesId: string) {
  const s = await prisma.playoffSeries.findUnique({
    where: { id: seriesId },
    select: { id: true, seasonId: true, round: true, teamSeasonAId: true, teamSeasonBId: true, scoreA: true, scoreB: true, winnerTeamSeasonId: true },
  });
  if (!s) return null;
  const teamIds = [s.teamSeasonAId, s.teamSeasonBId].filter((x): x is string => !!x);
  const [season, teamSeasons, entries] = await Promise.all([
    prisma.tourSeason.findUnique({ where: { id: s.seasonId }, select: { name: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: teamIds } }, include: { team: true } }),
    prisma.playoffEntry.findMany({ where: { seasonId: s.seasonId }, select: { teamSeasonId: true, seed: true } }),
  ]);
  const nameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));
  return {
    seriesId: s.id,
    seasonName: season?.name ?? "",
    roundLabel: ROUND_LABEL[s.round as Round] ?? s.round,
    aName: s.teamSeasonAId ? nameOf.get(s.teamSeasonAId) ?? "TBD" : "TBD",
    bName: s.teamSeasonBId ? nameOf.get(s.teamSeasonBId) ?? "TBD" : "TBD",
    aSeed: s.teamSeasonAId ? seedOf.get(s.teamSeasonAId) ?? null : null,
    bSeed: s.teamSeasonBId ? seedOf.get(s.teamSeasonBId) ?? null : null,
    scoreA: s.scoreA ?? 0,
    scoreB: s.scoreB ?? 0,
    winner: s.winnerTeamSeasonId === s.teamSeasonAId ? ("A" as const) : s.winnerTeamSeasonId === s.teamSeasonBId ? ("B" as const) : null,
    decided: !!s.winnerTeamSeasonId,
  };
}
