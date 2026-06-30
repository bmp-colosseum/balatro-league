// Projected playoff bracket for a conference season: top-N per conference →
// seed overall → quarterfinal pairings. Exercises competition-core's qualify +
// seedField + standardBracketPairings on real standings. (For seasons whose
// actual playoff results aren't recorded.)
import { qualify, seedField, standardBracketPairings, type StandingRow } from "@balatro/competition-core";
import { getSeasonStandings } from "./standings";

const pct = (w: number, l: number) => (w + l ? w / (w + l) : 0);
const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0;

export interface PlayoffPicture {
  perGroup: number;
  qualifiers: { name: string; teamSeasonId: string; conference: string; seed: number }[];
  quarterfinals: { a: string; aTeamSeasonId: string; b: string; bTeamSeasonId: string }[];
}

export async function getPlayoffPicture(seasonName: string): Promise<PlayoffPicture | null> {
  const s = await getSeasonStandings(seasonName);
  if (!s || s.format !== "CONFERENCES" || s.groups.length < 2) return null;
  const perGroup = Math.max(1, Math.floor(s.playoffTeams / Math.max(1, s.groups.length)));

  const nameById = new Map<string, string>();
  const confById = new Map<string, string>();
  const byGroup = new Map<string, StandingRow[]>();
  const overall: { id: string; m: number; se: number; g: number }[] = [];

  for (const grp of s.groups) {
    const rows: StandingRow[] = grp.rows.map((r) => {
      nameById.set(r.teamSeasonId, r.name);
      confById.set(r.teamSeasonId, grp.conferenceName);
      overall.push({ id: r.teamSeasonId, m: pct(r.matchupsW, r.matchupsL), se: pct(r.setsW, r.setsL), g: pct(r.gamesW, r.gamesL) });
      return {
        participantId: r.teamSeasonId,
        groupId: grp.conferenceId,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0,
        metrics: {},
      };
    });
    byGroup.set(grp.conferenceId, rows);
  }

  const overallRanked = overall.sort((a, b) => b.m - a.m || b.se - a.se || b.g - a.g).map((r) => r.id);
  const field = qualify({ byGroup, overallRanked, perGroup, fieldSize: s.playoffTeams });
  const seeded = seedField(field, overallRanked);
  if (!isPow2(seeded.length)) {
    return {
      perGroup,
      qualifiers: seeded.map((id, i) => ({ name: nameById.get(id) ?? id, teamSeasonId: id, conference: confById.get(id) ?? "", seed: i + 1 })),
      quarterfinals: [],
    };
  }
  const seedOf = new Map(seeded.map((id, i) => [id, i + 1]));
  const qf = standardBracketPairings(seeded);
  return {
    perGroup,
    qualifiers: seeded.map((id, i) => ({ name: nameById.get(id) ?? id, teamSeasonId: id, conference: confById.get(id) ?? "", seed: i + 1 })),
    quarterfinals: qf.map(([a, b]) => ({
      a: `#${seedOf.get(a)} ${nameById.get(a) ?? a}`,
      aTeamSeasonId: a,
      b: `#${seedOf.get(b)} ${nameById.get(b) ?? b}`,
      bTeamSeasonId: b,
    })),
  };
}
