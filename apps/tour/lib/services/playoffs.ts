// Playoffs service (B8). Single-elim bracket of any power-of-2 field. Two entry points:
//   - startPlayoffs / startPlayoffsManual: one flat seeded bracket (League-style / manual).
//   - startConferencePlayoffs: a bracket PER conference (choose-your-opponent), whose
//     champions cross in the later rounds -> the cross-conference final.
// A round is identified by how many teams enter it (2=Final, 4=Semifinal, 8=Quarterfinal,
// 16=Round of 16, ...), so the depth is derived from the field size -- nothing is capped at
// three rounds. Conference series are real Matchups in Week(kind=PLAYOFF) rows at the round's
// pseudo-week, so games are paired + reported through the normal console and the series result
// derives from them; flat brackets keep the manual per-series score.
import { qualify, seedField, standardBracketPairings, advanceWinners, assembleBracketByChoice, type StandingRow } from "@balatro/competition-core";
import { getSeasonStandings } from "../standings";
import { prisma } from "../db";
import { notifyLive } from "../notify";
import { regularWeekCount, roundWeekOf, playoffFieldSize, ROUND_BY_TEAMS, TEAMS_BY_ROUND, ROUND_LABEL } from "./playoff-weeks";

type Round = "ROUND_OF_64" | "ROUND_OF_32" | "ROUND_OF_16" | "QUARTERFINAL" | "SEMIFINAL" | "FINAL";

// Round helpers derived from team counts -- no fixed round set.
const roundForTeams = (teams: number): Round | null => (ROUND_BY_TEAMS[teams] as Round | undefined) ?? null;
const teamsInRound = (round: string): number => TEAMS_BY_ROUND[round] ?? 0;
const nextRoundOf = (round: string): Round | null => roundForTeams(teamsInRound(round) / 2); // half the teams advance
const roundOrder = (round: string): number => -(TEAMS_BY_ROUND[round] ?? 0); // more teams = earlier round

const pct = (w: number, l: number) => (w + l ? w / (w + l) : 0);
const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0; // valid bracket field (>= 2)
const pow2OrOne = (n: number) => n >= 1 && (n & (n - 1)) === 0; // valid conference count (1, 2, 4, ...)

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
    valid: isPow2(seeded.length) && !!roundForTeams(seeded.length),
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
    throw new Error("Playoffs already started -- reset first.");
  }
  const field = await computeSeededField(seasonName);
  if (!field) throw new Error("No standings for this season yet.");
  if (!field.valid) throw new Error(`Need a power-of-2 field (2..64) -- standings produced ${field.seeded.length} qualifiers.`);

  await prisma.playoffEntry.createMany({
    data: field.seeded.map((q) => ({ seasonId: season.id, teamSeasonId: q.teamSeasonId, seed: q.seed, viaWildcard: q.viaWildcard })),
  });

  const seededIds = field.seeded.map((q) => q.teamSeasonId);
  const round = roundForTeams(field.seeded.length)!;
  const pairs = standardBracketPairings(seededIds);
  await prisma.playoffSeries.createMany({
    data: pairs.map(([a, b], i) => ({ seasonId: season.id, round, bracketIndex: i, teamSeasonAId: a, teamSeasonBId: b })),
  });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "PLAYOFFS" } });
  return { field: field.seeded.length, round };
}

// Manual bracket: the TO picks the exact field in seed order (index 0 = seed 1). Same
// persistence as startPlayoffs, but the field + seeds come from the TO, not the standings.
export async function startPlayoffsManual(seasonName: string, teamSeasonIds: string[]) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if ((await prisma.playoffEntry.count({ where: { seasonId: season.id } })) > 0) {
    throw new Error("Playoffs already started -- reset first.");
  }
  const ids = teamSeasonIds.filter(Boolean);
  if ([...new Set(ids)].length !== ids.length) throw new Error("A team can't be seeded twice.");
  if (!isPow2(ids.length) || !roundForTeams(ids.length)) {
    throw new Error(`Pick a power-of-2 field (2..64) -- you picked ${ids.length}.`);
  }
  await prisma.playoffEntry.createMany({
    data: ids.map((id, i) => ({ seasonId: season.id, teamSeasonId: id, seed: i + 1, viaWildcard: false })),
  });
  const round = roundForTeams(ids.length)!;
  const pairs = standardBracketPairings(ids); // ids already in seed order
  await prisma.playoffSeries.createMany({
    data: pairs.map(([a, b], i) => ({ seasonId: season.id, round, bracketIndex: i, teamSeasonAId: a, teamSeasonBId: b })),
  });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "PLAYOFFS" } });
  return { field: ids.length, round };
}

// ── Conference playoffs (choose-your-opponent) ───────────────────────────────
// Each conference runs its own single-elim bracket: top-`berths` of the conference by
// regular-season standings; the #1 seed PICKS its first-round opponent from the lower half,
// #2 gets the leftover (assembleBracketByChoice). Conferences are laid out contiguously, so
// each stays self-contained until the bracket naturally merges them near the end (2 conferences
// cross at the FINAL; 4 at the semifinals; ...). Field = conferences x berths (both powers of 2).

// Find-or-create the single Week(kind=PLAYOFF) that holds a round's matchups.
async function ensurePlayoffWeek(seasonId: string, weekNumber: number): Promise<string> {
  const existing = await prisma.week.findUnique({ where: { seasonId_number: { seasonId, number: weekNumber } }, select: { id: true, kind: true } });
  if (existing) {
    if (existing.kind !== "PLAYOFF") await prisma.week.update({ where: { id: existing.id }, data: { kind: "PLAYOFF" } });
    return existing.id;
  }
  const w = await prisma.week.create({ data: { seasonId, number: weekNumber, kind: "PLAYOFF" } });
  return w.id;
}

// The Matchup that plays out one series. A = higher seed (proposes first in playoffs).
async function createSeriesMatchup(weekId: string, aTsId: string, bTsId: string): Promise<string> {
  const mu = await prisma.matchup.create({ data: { weekId, teamSeasonAId: aTsId, teamSeasonBId: bTsId, sendFirstTeamSeasonId: aTsId } });
  return mu.id;
}

export interface ConferencePick {
  conferenceId: string;
  chosenOpponentTeamSeasonId: string; // the #1 seed's chosen first-round opponent (a lower seed)
}

export async function startConferencePlayoffs(seasonName: string, picks: ConferencePick[]) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, format: true, playoffTeams: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (season.format !== "CONFERENCES") throw new Error("Conference playoffs need a CONFERENCES-format season.");
  if ((await prisma.playoffEntry.count({ where: { seasonId: season.id } })) > 0) throw new Error("Playoffs already started -- reset first.");

  const standings = await getSeasonStandings(seasonName);
  if (!standings || standings.groups.length < 1) throw new Error("No standings for this season yet.");
  const conferences = standings.groups.length;
  if (!pow2OrOne(conferences)) throw new Error(`Conference playoffs need a power-of-2 number of conferences (this season has ${conferences}).`);
  const berths = Math.floor(season.playoffTeams / conferences);
  if (berths < 2 || !isPow2(berths)) throw new Error(`Each conference needs a power-of-2 team count of at least 2 (playoffTeams/conferences = ${berths}).`);
  const field = conferences * berths;
  const firstRound = roundForTeams(field);
  if (!firstRound) throw new Error(`Playoff field of ${field} is out of range (2..64).`);
  const half = berths / 2;
  const pickByConf = new Map(picks.map((p) => [p.conferenceId, p.chosenOpponentTeamSeasonId]));

  const entryRows: { teamSeasonId: string; seed: number }[] = [];
  const firstPairs: { conferenceId: string; a: string; b: string }[] = [];

  for (const g of standings.groups) {
    const top = g.rows.slice(0, berths).map((r) => r.teamSeasonId);
    if (top.length < berths) throw new Error(`Conference ${g.conferenceName} has ${top.length} teams; need ${berths} for the bracket.`);
    top.forEach((id, i) => entryRows.push({ teamSeasonId: id, seed: i + 1 })); // per-conference seed 1..berths

    const choosers = top.slice(0, half); // #1..#half
    const pickable = top.slice(half); // lower half = the eligible first-round opponents
    const chosen = pickByConf.get(g.conferenceId);
    if (!chosen) throw new Error(`No first-round opponent picked for conference ${g.conferenceName}.`);
    if (!pickable.includes(chosen)) throw new Error(`${g.conferenceName}: the #1 seed must pick a lower seed as its opponent.`);
    // #1 gets its pick; the remaining choosers take the leftover pickables in order.
    const picksMap: Record<string, string> = { [choosers[0]!]: chosen };
    const leftovers = pickable.filter((id) => id !== chosen);
    for (let i = 1; i < choosers.length; i++) picksMap[choosers[i]!] = leftovers[i - 1]!;

    const res = assembleBracketByChoice(top, picksMap);
    if (!res.ok) throw new Error(`${g.conferenceName}: ${res.reason}`);
    for (const [a, b] of res.pairs) firstPairs.push({ conferenceId: g.conferenceId, a, b });
  }

  await prisma.playoffEntry.createMany({ data: entryRows.map((e) => ({ seasonId: season.id, teamSeasonId: e.teamSeasonId, seed: e.seed, viaWildcard: false })) });

  // First-round series laid out conference-contiguous, so the consecutive-winner advance keeps
  // each conference self-contained until its sub-bracket merges into the cross-conference stage.
  const seedOf = new Map(entryRows.map((e) => [e.teamSeasonId, e.seed]));
  const regularWeeks = (await regularWeekCount(season.id)) || 0;
  const firstWeekId = await ensurePlayoffWeek(season.id, roundWeekOf(regularWeeks, field, firstRound));
  let bi = 0;
  for (const p of firstPairs) {
    const [aId, bId] = (seedOf.get(p.a) ?? 99) <= (seedOf.get(p.b) ?? 99) ? [p.a, p.b] : [p.b, p.a];
    const matchupId = await createSeriesMatchup(firstWeekId, aId, bId);
    await prisma.playoffSeries.create({ data: { seasonId: season.id, round: firstRound, bracketIndex: bi++, conferenceId: p.conferenceId, teamSeasonAId: aId, teamSeasonBId: bId, matchupId } });
  }

  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "PLAYOFFS" } });
  return { conferences, berths, field, firstRound, series: firstPairs.length };
}

// The per-conference setup the admin renders before starting: each conference's
// top-`berths` standings, its #1 chooser, and the lower seeds it may pick from.
async function computeConferenceSetup(seasonName: string) {
  const s = await getSeasonStandings(seasonName);
  if (!s || s.format !== "CONFERENCES" || s.groups.length < 1) return null;
  const conferences = s.groups.length;
  const berths = Math.floor(s.playoffTeams / Math.max(1, conferences));
  const half = Math.max(1, Math.floor(berths / 2));
  return {
    berths,
    // Any power-of-2 conferences x power-of-2 berths (field 2..64) is supported.
    supported: pow2OrOne(conferences) && berths >= 2 && isPow2(berths) && !!roundForTeams(conferences * berths),
    conferences: s.groups.map((g) => {
      const top = g.rows.slice(0, berths);
      const chooser = top[0];
      const pickables = top.slice(half);
      return {
        conferenceId: g.conferenceId,
        conferenceName: g.conferenceName,
        enoughTeams: top.length >= berths,
        seeds: top.map((r, i) => ({ teamSeasonId: r.teamSeasonId, name: r.name, seed: i + 1 })),
        chooser: chooser ? { teamSeasonId: chooser.teamSeasonId, name: chooser.name } : null,
        pickables: pickables.map((r, i) => ({ teamSeasonId: r.teamSeasonId, name: r.name, seed: half + i + 1 })),
      };
    }),
  };
}

// Delete every round strictly AFTER `round` (fewer teams) -- its series + their matchups
// (cascades TourSets) + the referenced Matches. Used when a decided feeder result changes and
// the already-built downstream rounds must be rebuilt from the corrected winners.
async function teardownRoundsAfter(seasonId: string, round: string) {
  const cutoff = teamsInRound(round);
  const all = await prisma.playoffSeries.findMany({ where: { seasonId }, select: { id: true, round: true, matchupId: true } });
  const stale = all.filter((s) => teamsInRound(s.round) > 0 && teamsInRound(s.round) < cutoff);
  if (!stale.length) return;
  const matchupIds = stale.map((s) => s.matchupId).filter((x): x is string => !!x);
  if (matchupIds.length) {
    const sets = await prisma.tourSet.findMany({ where: { matchupId: { in: matchupIds } }, select: { matchId: true } });
    const matchIds = sets.map((x) => x.matchId).filter((x): x is string => !!x);
    if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.matchup.deleteMany({ where: { id: { in: matchupIds } } }); // cascades TourSets
  }
  await prisma.playoffSeries.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

// A playoff Matchup just rolled up (report.ts) -> mirror its team result onto the linked
// series and, if the round is complete, build the next round. If a decided feeder's winner
// FLIPS (or is un-reported) after later rounds were built, tear those rounds down so they
// rebuild from the corrected winners -- the bracket never silently disagrees with itself.
export async function syncSeriesFromMatchup(matchupId: string) {
  const series = await prisma.playoffSeries.findFirst({ where: { matchupId } });
  if (!series) return; // regular matchup, or a series without a live matchup
  const mu = await prisma.matchup.findUnique({ where: { id: matchupId }, select: { teamSeasonAId: true, setsWonA: true, setsWonB: true, winnerTeamSeasonId: true } });
  if (!mu) return;
  const priorWinner = series.winnerTeamSeasonId;

  if (mu.setsWonA == null || mu.setsWonB == null || !mu.winnerTeamSeasonId) {
    // Back to undecided (an un-report): clear the series and tear down anything built from it.
    if (priorWinner || series.scoreA != null) {
      await prisma.playoffSeries.update({ where: { id: series.id }, data: { scoreA: null, scoreB: null, winnerTeamSeasonId: null } });
      if (priorWinner) await teardownRoundsAfter(series.seasonId, series.round);
    }
    await notifyLive(`series:${series.id}`);
    return;
  }

  const aIsMatchupA = series.teamSeasonAId === mu.teamSeasonAId;
  const scoreA = aIsMatchupA ? mu.setsWonA : mu.setsWonB;
  const scoreB = aIsMatchupA ? mu.setsWonB : mu.setsWonA;
  await prisma.playoffSeries.update({ where: { id: series.id }, data: { scoreA, scoreB, winnerTeamSeasonId: mu.winnerTeamSeasonId } });
  if (priorWinner && priorWinner !== mu.winnerTeamSeasonId) await teardownRoundsAfter(series.seasonId, series.round);
  await maybeAdvance(series.seasonId, series.round);
  await notifyLive(`series:${series.id}`);
}

// Manually set (or swap) the two teams in a series -- the "build the bracket by hand" lever for
// flat/manual brackets. Live conference series are played through their matchup, so they can't
// be hand-edited here (that would desync the series from its matchup).
export async function setSeriesTeams(seriesId: string, teamSeasonAId: string, teamSeasonBId: string) {
  const s = await prisma.playoffSeries.findUnique({
    where: { id: seriesId },
    select: { id: true, seasonId: true, teamSeasonAId: true, teamSeasonBId: true, matchupId: true },
  });
  if (!s) throw new Error("No such series.");
  if (s.matchupId) throw new Error("This series is played through its matchup -- change or report its games in the matchup console, not here.");
  if (!teamSeasonAId || !teamSeasonBId) throw new Error("Pick both teams.");
  if (teamSeasonAId === teamSeasonBId) throw new Error("A series needs two different teams.");
  const entries = await prisma.playoffEntry.findMany({ where: { seasonId: s.seasonId }, select: { teamSeasonId: true, seed: true } });
  const have = new Set(entries.map((e) => e.teamSeasonId));
  let nextSeed = Math.max(0, ...entries.map((e) => e.seed));
  for (const id of [teamSeasonAId, teamSeasonBId]) {
    if (!have.has(id)) {
      nextSeed += 1;
      await prisma.playoffEntry.create({ data: { seasonId: s.seasonId, teamSeasonId: id, seed: nextSeed, viaWildcard: false } });
      have.add(id);
    }
  }
  const changed = teamSeasonAId !== s.teamSeasonAId || teamSeasonBId !== s.teamSeasonBId;
  await prisma.playoffSeries.update({
    where: { id: seriesId },
    data: { teamSeasonAId, teamSeasonBId, ...(changed ? { scoreA: null, scoreB: null, winnerTeamSeasonId: null } : {}) },
  });
  await notifyLive(`series:${seriesId}`);
  return { ok: true };
}

export async function reportSeries(seriesId: string, scoreA: number, scoreB: number) {
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    throw new Error("Scores must be whole numbers >= 0.");
  }
  if (scoreA === scoreB) throw new Error("A playoff series needs a winner (no ties).");
  const series = await prisma.playoffSeries.findUnique({ where: { id: seriesId } });
  if (!series) throw new Error("No such series.");
  if (series.matchupId) throw new Error("This series is played through its matchup -- report its games in the matchup console.");
  const winnerTeamSeasonId = scoreA > scoreB ? series.teamSeasonAId : series.teamSeasonBId;
  await prisma.playoffSeries.update({ where: { id: seriesId }, data: { scoreA, scoreB, winnerTeamSeasonId } });
  await maybeAdvance(series.seasonId, series.round);
  // Live-refresh any open series scoreboard overlay (OBS browser source).
  await notifyLive(`series:${seriesId}`);
  return { champion: series.round === "FINAL" };
}

// When every series in a round has a winner, build the next round from the winners
// (in bracket order). No-op past the FINAL or if the next round already exists.
async function maybeAdvance(seasonId: string, round: Round) {
  const next = nextRoundOf(round);
  if (!next) return;
  const roundSeries = await prisma.playoffSeries.findMany({ where: { seasonId, round }, orderBy: { bracketIndex: "asc" } });
  if (roundSeries.length === 0 || roundSeries.some((s) => !s.winnerTeamSeasonId)) return;
  if ((await prisma.playoffSeries.count({ where: { seasonId, round: next } })) > 0) return;

  // Live/conference brackets (series backed by real matchups) build the next round as real
  // matchups too, pairing consecutive winners (0&1, 2&3, ...) and carrying the conference
  // through while both feeders share it (null once conferences cross). Flat/manual brackets
  // keep the original advanceWinners persistence.
  const liveMode = roundSeries.some((s) => s.matchupId);
  if (!liveMode) {
    const winners = roundSeries.map((s) => s.winnerTeamSeasonId!).filter((x): x is string => !!x);
    const pairs = advanceWinners(winners);
    await prisma.playoffSeries.createMany({
      data: pairs.map(([a, b], i) => ({ seasonId, round: next, bracketIndex: i, teamSeasonAId: a, teamSeasonBId: b })),
    });
    return;
  }

  const regularWeeks = (await regularWeekCount(seasonId)) || 0;
  const field = await playoffFieldSize(seasonId);
  const weekId = await ensurePlayoffWeek(seasonId, roundWeekOf(regularWeeks, field, next));
  const entries = await prisma.playoffEntry.findMany({ where: { seasonId }, select: { teamSeasonId: true, seed: true } });
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));
  for (let i = 0; i * 2 + 1 < roundSeries.length; i++) {
    const fA = roundSeries[i * 2]!;
    const fB = roundSeries[i * 2 + 1]!;
    const conferenceId = fA.conferenceId && fA.conferenceId === fB.conferenceId ? fA.conferenceId : null;
    const [aId, bId] = (seedOf.get(fA.winnerTeamSeasonId!) ?? 99) <= (seedOf.get(fB.winnerTeamSeasonId!) ?? 99)
      ? [fA.winnerTeamSeasonId!, fB.winnerTeamSeasonId!]
      : [fB.winnerTeamSeasonId!, fA.winnerTeamSeasonId!];
    const matchupId = await createSeriesMatchup(weekId, aId, bId);
    await prisma.playoffSeries.create({ data: { seasonId, round: next, bracketIndex: i, conferenceId, teamSeasonAId: aId, teamSeasonBId: bId, matchupId } });
  }
}

export async function resetPlayoffs(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  // Remove the playoff Weeks the bracket created (cascades their Matchups + TourSets) plus the
  // core Matches those sets referenced (Match has no cascade), so a re-start is fully clean.
  const pweeks = await prisma.week.findMany({ where: { seasonId: season.id, kind: "PLAYOFF" }, select: { id: true } });
  const weekIds = pweeks.map((w) => w.id);
  if (weekIds.length) {
    const psets = await prisma.tourSet.findMany({ where: { matchup: { weekId: { in: weekIds } } }, select: { matchId: true } });
    const matchIds = psets.map((x) => x.matchId).filter((x): x is string => !!x);
    if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.week.deleteMany({ where: { id: { in: weekIds } } }); // cascades matchups + toursets
  }
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

  // Every team in the season, for the manual bracket pickers (field builder + per-series edit).
  const allTeamSeasons = await prisma.teamSeason.findMany({
    where: { seasonId: season.id },
    include: { team: { select: { name: true } } },
    orderBy: { seed: "asc" },
  });
  const allTeams = allTeamSeasons.map((t) => ({ id: t.id, name: t.team.name }));

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
    const conferenceSetup = await computeConferenceSetup(seasonName);
    return { started: false as const, seasonState: season.state, projected: field, pairings, allTeams, conferenceSetup };
  }

  const series = await prisma.playoffSeries.findMany({
    where: { seasonId: season.id },
    orderBy: [{ bracketIndex: "asc" }],
  });
  const tsIds = [...new Set([...entries.map((e) => e.teamSeasonId), ...series.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId])].filter((x): x is string => !!x))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const nameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));
  const confs = await prisma.conference.findMany({ where: { seasonId: season.id }, select: { id: true, name: true } });
  const confName = new Map(confs.map((c) => [c.id, c.name]));
  const label = (id: string | null) => (id ? `#${seedOf.get(id) ?? "?"} ${nameOf.get(id) ?? id}` : "--");

  const byRound = new Map<string, typeof series>();
  for (const s of series) {
    const arr = byRound.get(s.round) ?? [];
    arr.push(s);
    byRound.set(s.round, arr);
  }
  const rounds = [...byRound.entries()]
    .sort((a, b) => roundOrder(a[0]) - roundOrder(b[0]))
    .map(([round, ss]) => ({
      round,
      label: ROUND_LABEL[round] ?? round,
      series: ss
        .sort((a, b) => a.bracketIndex - b.bracketIndex)
        .map((s) => ({
          id: s.id,
          aId: s.teamSeasonAId,
          bId: s.teamSeasonBId,
          aLabel: label(s.teamSeasonAId),
          bLabel: label(s.teamSeasonBId),
          conferenceId: s.conferenceId,
          conferenceName: s.conferenceId ? confName.get(s.conferenceId) ?? null : null,
          matchupId: s.matchupId,
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
    allTeams,
    entries: entries.map((e) => ({ seed: e.seed, name: nameOf.get(e.teamSeasonId) ?? e.teamSeasonId, viaWildcard: e.viaWildcard })),
    rounds,
    champion,
  };
}

// One playoff series, trimmed for the scoreboard overlay: team names + seeds + the series
// score + round + winner. Live-updates via the `series:<id>` scope.
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
    roundLabel: ROUND_LABEL[s.round] ?? s.round,
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
