// End-to-end integration test (DEV DB) for conference pick-your-opponent playoffs.
// Runs the whole flow against the dev "Team Tour 4" copy, then FULLY cleans up:
//   build bracket -> assert QF shape -> drive each series via the normal reportSet path
//   -> assert sync + advance (SF conf-finals -> cross FINAL -> champion) -> restore.
// Run: cd apps/tour && npx tsx scripts/it-conf-playoffs.ts
import { prisma } from "../lib/db";
import { getSeasonStandings } from "../lib/standings";
import { startConferencePlayoffs, resetPlayoffs } from "../lib/services/playoffs";
import { reportSet } from "../lib/services/report";

const SEASON = "Team Tour 4";
let ok = true;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "OK  " : "FAIL"} ${label}`); if (!cond) ok = false; };

async function cleanup(seasonId: string, priorState: string) {
  // resetPlayoffs clears series/entries/championship; we also drop the PLAYOFF weeks
  // (cascade matchups + sets) and their core Matches, then restore the season state.
  const pweeks = await prisma.week.findMany({ where: { seasonId, kind: "PLAYOFF" as never }, select: { id: true } });
  const wids = pweeks.map((w) => w.id);
  if (wids.length) {
    const psets = await prisma.tourSet.findMany({ where: { matchup: { weekId: { in: wids } } }, select: { matchId: true } });
    const mids = psets.map((s) => s.matchId).filter((x): x is string => !!x);
    if (mids.length) await prisma.match.deleteMany({ where: { id: { in: mids } } });
    await prisma.week.deleteMany({ where: { id: { in: wids } } }); // cascades matchups + toursets
  }
  await resetPlayoffs(SEASON).catch(() => {});
  await prisma.tourSeason.update({ where: { id: seasonId }, data: { state: priorState as never } });
}

async function aPlayerOf(teamSeasonId: string): Promise<string | null> {
  const e = await prisma.rosterEntry.findFirst({ where: { roster: { teamSeasonId } }, select: { playerId: true } });
  return e?.playerId ?? null;
}

// Drive a single series to a decision through the real report path: one set, team A wins.
async function decideSeries(matchupId: string, seasonId: string) {
  const mu = await prisma.matchup.findUnique({ where: { id: matchupId }, select: { teamSeasonAId: true, teamSeasonBId: true } });
  if (!mu) throw new Error("no matchup");
  const [pa, pb] = await Promise.all([aPlayerOf(mu.teamSeasonAId), aPlayerOf(mu.teamSeasonBId)]);
  if (!pa || !pb) throw new Error("teams have no roster players to pair");
  const set = await prisma.tourSet.create({
    data: { matchupId, seasonId, playerAId: pa, playerBId: pb, seedA: 1, seedB: 1, bestOf: 1, status: "PROPOSED",
      teamSeasonAId: mu.teamSeasonAId, teamSeasonBId: mu.teamSeasonBId, bracket: "PLAYOFF" },
  });
  await reportSet(set.id, 1, 0); // team A wins -> matchup decided (only set) -> series sync -> advance
}

async function seriesRows(seasonId: string) {
  return prisma.playoffSeries.findMany({ where: { seasonId }, orderBy: [{ round: "asc" }, { bracketIndex: "asc" }],
    select: { round: true, bracketIndex: true, conferenceId: true, teamSeasonAId: true, teamSeasonBId: true, scoreA: true, scoreB: true, winnerTeamSeasonId: true, matchupId: true } });
}

async function main() {
  const season = await prisma.tourSeason.findUnique({ where: { name: SEASON }, select: { id: true, state: true } });
  if (!season) throw new Error(`no dev season ${SEASON}`);
  const priorState = season.state;
  console.log(`Dev season ${SEASON} [${priorState}] -- cleaning any prior bracket first.`);
  await cleanup(season.id, priorState);

  const standings = await getSeasonStandings(SEASON);
  if (!standings) throw new Error("no standings");
  const picks = standings.groups.map((g) => ({ conferenceId: g.conferenceId, chosenOpponentTeamSeasonId: g.rows[3]!.teamSeasonId })); // #1 picks #4
  console.log(`\nBuilding: each #1 picks its #4 seed.`);
  const built = await startConferencePlayoffs(SEASON, picks);
  check(`start returns 2 conferences / 4 first-round series`, built.conferences === 2 && built.series === 4);

  let rows = await seriesRows(season.id);
  const qf = rows.filter((r) => r.round === "QUARTERFINAL");
  check(`4 QF series created`, qf.length === 4);
  check(`every QF has a matchup + conference`, qf.every((r) => r.matchupId && r.conferenceId));
  check(`QF conference-contiguous (0,1 same conf; 2,3 same conf; halves differ)`,
    qf[0]!.conferenceId === qf[1]!.conferenceId && qf[2]!.conferenceId === qf[3]!.conferenceId && qf[0]!.conferenceId !== qf[2]!.conferenceId);
  const entries = await prisma.playoffEntry.findMany({ where: { seasonId: season.id } });
  check(`8 playoff entries, seeds 1..4 twice`, entries.length === 8 && entries.filter((e) => e.seed === 1).length === 2);
  // #1 (seed 1) plays #4 (seed 4) in each conference, per the pick
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));
  const oneVsFour = qf.filter((r) => { const s = [seedOf.get(r.teamSeasonAId!), seedOf.get(r.teamSeasonBId!)].sort(); return s[0] === 1 && s[1] === 4; });
  check(`each conference's #1 drew its #4 (the pick)`, oneVsFour.length === 2);

  console.log(`\nDriving QF results via the normal reportSet path (team A wins each)...`);
  for (const r of qf) await decideSeries(r.matchupId!, season.id);
  rows = await seriesRows(season.id);
  const qf2 = rows.filter((r) => r.round === "QUARTERFINAL");
  check(`all QF series decided + scored from the matchup`, qf2.every((r) => r.winnerTeamSeasonId && r.scoreA === 1 && r.scoreB === 0));
  const sf = rows.filter((r) => r.round === "SEMIFINAL");
  check(`2 SF (conference finals) auto-created with matchups`, sf.length === 2 && sf.every((r) => r.matchupId && r.conferenceId));
  check(`SF are conference-contained (each has a conferenceId)`, sf.every((r) => !!r.conferenceId) && sf[0]!.conferenceId !== sf[1]!.conferenceId);

  console.log(`\nDriving SF results...`);
  for (const r of sf) await decideSeries(r.matchupId!, season.id);
  rows = await seriesRows(season.id);
  const fin = rows.filter((r) => r.round === "FINAL");
  check(`1 FINAL auto-created`, fin.length === 1);
  check(`FINAL is cross-conference (conferenceId null)`, fin[0]!.conferenceId === null);
  check(`FINAL has a matchup`, !!fin[0]!.matchupId);

  console.log(`\nDriving FINAL...`);
  await decideSeries(fin[0]!.matchupId!, season.id);
  rows = await seriesRows(season.id);
  const finDone = rows.find((r) => r.round === "FINAL")!;
  check(`champion decided (FINAL winner set)`, !!finDone.winnerTeamSeasonId);

  // standings must be UNCHANGED by all these playoff matchups (no pollution)
  const after = await getSeasonStandings(SEASON);
  const sameTop = after!.groups.every((g, i) => g.rows.slice(0, 4).map((r) => r.teamSeasonId).join(",") === standings.groups[i]!.rows.slice(0, 4).map((r) => r.teamSeasonId).join(","));
  check(`regular-season standings unchanged by playoff matchups`, sameTop);

  console.log(`\nCleaning up (restore dev season)...`);
  await cleanup(season.id, priorState);
  const leftoverWeeks = await prisma.week.count({ where: { seasonId: season.id, kind: "PLAYOFF" as never } });
  const leftoverSeries = await prisma.playoffSeries.count({ where: { seasonId: season.id } });
  check(`cleanup removed playoff weeks + series`, leftoverWeeks === 0 && leftoverSeries === 0);

  console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(ok ? 0 : 1);
}
main().catch(async (e) => { console.error(e); process.exit(1); });
