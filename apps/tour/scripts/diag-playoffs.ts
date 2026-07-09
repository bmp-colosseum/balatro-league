// Read-only probe: TT4 playoff-relevant structure.
//   conferences, teams per conference (seed order), season state,
//   any existing PlayoffSeries / playoff Weeks / playoff Matchups.
// Run: cd apps/tour && DATABASE_URL='<prod>' npx tsx scripts/diag-playoffs.ts "Team Tour 4"
import { prisma } from "../lib/db";

async function main() {
  const name = process.argv[2] || "Team Tour 4";
  const season = await prisma.tourSeason.findFirst({
    where: { name: { contains: name, mode: "insensitive" } },
    select: { id: true, name: true, state: true, format: true, conferenceCount: true, playoffTeams: true, teamSize: true, setsToWin: true },
  });
  if (!season) throw new Error(`season not found: ${name}`);
  console.log(`\n### ${season.name}  [${season.state}] format=${season.format} conferences=${season.conferenceCount} playoffTeams=${season.playoffTeams}\n`);

  const confs = await prisma.conference.findMany({ where: { seasonId: season.id }, select: { id: true, name: true } });
  const teams = await prisma.teamSeason.findMany({
    where: { seasonId: season.id },
    select: { id: true, seed: true, conferenceId: true, captainPlayerId: true, team: { select: { name: true } } },
    orderBy: { seed: "asc" },
  });
  for (const c of confs) {
    console.log(`Conference ${c.name}`);
    const ct = teams.filter((t) => t.conferenceId === c.id).sort((a, b) => a.seed - b.seed);
    for (const t of ct) console.log(`   seed ${String(t.seed).padStart(2)}  ${t.team.name}  (ts=${t.id})`);
    console.log(`   -> ${ct.length} teams\n`);
  }
  const unassigned = teams.filter((t) => !confs.some((c) => c.id === t.conferenceId));
  if (unassigned.length) console.log(`(${unassigned.length} team(s) not in a listed conference)\n`);

  const pweeks = await prisma.week.findMany({ where: { seasonId: season.id, kind: "PLAYOFF" as never }, select: { number: true, kind: true }, orderBy: { number: "asc" } }).catch(() => [] as { number: number; kind: string }[]);
  console.log(`Playoff Weeks: ${pweeks.length ? pweeks.map((w) => `W${w.number}`).join(", ") : "none"}`);

  const series = await prisma.playoffSeries.findMany({ where: { seasonId: season.id }, select: { round: true, bracketIndex: true, teamSeasonAId: true, teamSeasonBId: true, scoreA: true, scoreB: true, winnerTeamSeasonId: true, matchupId: true }, orderBy: [{ round: "asc" }, { bracketIndex: "asc" }] });
  console.log(`PlayoffSeries: ${series.length}`);
  const nameOf = (id: string | null) => (id ? teams.find((t) => t.id === id)?.team.name ?? id.slice(0, 8) : "-");
  for (const s of series) console.log(`   ${s.round} #${s.bracketIndex}: ${nameOf(s.teamSeasonAId)} vs ${nameOf(s.teamSeasonBId)}  ${s.scoreA ?? "-"}-${s.scoreB ?? "-"}  win=${nameOf(s.winnerTeamSeasonId)}  ${s.matchupId ? "[matchup]" : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
