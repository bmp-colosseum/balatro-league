// Read-only: per-conference regular-season standings for a season (the playoff seed source).
// Run: cd apps/tour && DATABASE_URL='<prod>' npx tsx scripts/diag-standings.ts "Team Tour 4"
import { getSeasonStandings } from "../lib/standings";

async function main() {
  const name = process.argv[2] || "Team Tour 4";
  const s = await getSeasonStandings(name);
  console.log(`\n### ${s.seasonName}  format=${s.format} conferences=${s.conferenceCount} playoffTeams=${s.playoffTeams} sets/matchup=${s.setCount ?? "?"}\n`);
  const berths = s.conferenceCount ? Math.floor(s.playoffTeams / s.conferenceCount) : s.playoffTeams;
  for (const g of s.groups) {
    console.log(`Conference ${g.conferenceName}  (top ${berths} advance)`);
    g.rows.forEach((r, i) => {
      const rank = i + 1;
      const inField = rank <= berths ? "*" : " ";
      console.log(`  ${inField}#${rank}  ${r.name.padEnd(26)}  MP ${r.matchupsW}-${r.matchupsL}  sets ${r.setsW}-${r.setsL}  games ${r.gamesW}-${r.gamesL}`);
    });
    console.log("");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
