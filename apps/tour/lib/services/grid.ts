// Coverage grid -- "who has played whom, and where are the holes?". Per conference,
// a full head-to-head matrix: every filled cell is a matchup that happened (with its
// set score); every blank cell is two teams that never met -- a candidate missing match.
//
// It reads from BOTH match-storage models so it works on any season with zero setup:
//   * live / reconciled seasons -- team identity + rolled-up result live on Matchup rows.
//   * imported-but-not-reconciled seasons (e.g. TT4) -- results are flat TourSets tagged
//     with teamSeasonAId/BId + week (matchupId null); we aggregate them per (week, pair).
// A season is one or the other (reconcile sets matchupId on the flat sets), so no
// double counting. Read-only; derive-on-read over whatever rows exist.
//
// The grid CANNOT distinguish "scheduled, not played yet" from "never going to play" for
// imported seasons -- those unplayed fixtures were dropped at import. A blank cell shows
// the hole; only the TO knows which holes are real games still owed. That's the fill-in.
import { prisma } from "../db";

// One team-pair encounter, oriented to the canonical (lexicographically smaller) id.
interface Meeting {
  loId: string;
  hiId: string;
  setsLo: number;
  setsHi: number;
  gamesLo: number;
  gamesHi: number;
  hasResult: boolean; // at least one set confirmed (vs a bare fixture with no play yet)
}

export interface GridCell {
  meetings: number; // how many times these two met (>1 in a double round-robin)
  setsFor: number; // from the ROW team's perspective
  setsAgainst: number;
  gamesFor: number;
  gamesAgainst: number;
  state: "played" | "scheduled"; // played = has a result; scheduled = fixture exists, no play yet
}

export interface GridTeam {
  teamSeasonId: string;
  name: string;
  seed: number;
  opponentsPlayed: number; // distinct in-conference opponents met (with a result)
  opponentsScheduled: number; // in-conf fixtures that exist but haven't been played
  missing: number; // in-conf opponents never met -- the blank cells (candidate missing games)
  possibleOpponents: number; // teams in the conference minus one (single round-robin target)
  totalMeetings: number; // all played meetings incl. cross-conference (sanity-check vs the record)
}

export interface ConferenceGrid {
  conferenceId: string;
  conferenceName: string;
  teams: GridTeam[];
  // rows[i].cells[j] = ROW team i vs COLUMN team j (same order as `teams`); null on the
  // diagonal (a team never plays itself) and where the pair never met.
  rows: { teamSeasonId: string; cells: (GridCell | null)[] }[];
}

export interface CrossMeeting {
  aName: string;
  bName: string;
  aConf: string;
  bConf: string;
  setsA: number;
  setsB: number;
  week: number | null;
}

export interface SeasonGrid {
  seasonName: string;
  format: string;
  conferences: ConferenceGrid[];
  crossConf: CrossMeeting[];
  totals: { teams: number; playedMeetings: number; missingPairs: number };
}

// Fold every meeting from Matchup rows AND flat imported TourSets into one canonical list.
async function loadMeetings(seasonId: string, setsToWin: number): Promise<Meeting[]> {
  const meetings: Meeting[] = [];

  // Source A -- Matchup rows (live play + reconciled imports). The rolled-up team result
  // is stored directly; a matchup with a null result is a fixture that isn't played yet.
  const matchups = await prisma.matchup.findMany({
    where: { week: { seasonId } },
    select: { teamSeasonAId: true, teamSeasonBId: true, setsWonA: true, setsWonB: true, gamesWonA: true, gamesWonB: true },
  });
  for (const m of matchups) {
    const aIsLo = m.teamSeasonAId < m.teamSeasonBId;
    const loId = aIsLo ? m.teamSeasonAId : m.teamSeasonBId;
    const hiId = aIsLo ? m.teamSeasonBId : m.teamSeasonAId;
    const hasResult = m.setsWonA != null && m.setsWonB != null;
    const sA = m.setsWonA ?? 0, sB = m.setsWonB ?? 0, gA = m.gamesWonA ?? 0, gB = m.gamesWonB ?? 0;
    meetings.push({
      loId, hiId,
      setsLo: aIsLo ? sA : sB, setsHi: aIsLo ? sB : sA,
      gamesLo: aIsLo ? gA : gB, gamesHi: aIsLo ? gB : gA,
      hasResult,
    });
  }

  // Source B -- flat imported sets not yet grouped into matchups. Aggregate the confirmed
  // sets per (week, unordered pair), aligning each set's win/games to the canonical team A
  // by player id (the same contract rollupMatchup uses).
  const flat = await prisma.tourSet.findMany({
    where: { seasonId, matchupId: null, week: { not: null }, bracket: "REGULAR", teamSeasonAId: { not: null }, teamSeasonBId: { not: null } },
    select: { week: true, teamSeasonAId: true, teamSeasonBId: true, playerAId: true, playerBId: true, status: true, matchId: true },
  });
  if (flat.length) {
    const matchIds = flat.map((s) => s.matchId).filter((x): x is string => !!x);
    const matches = matchIds.length
      ? await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, winnerId: true, playerAId: true, gamesWonA: true, gamesWonB: true } })
      : [];
    const mById = new Map(matches.map((m) => [m.id, m]));

    const groups = new Map<string, Meeting>();
    for (const s of flat) {
      const aIsLo = s.teamSeasonAId! < s.teamSeasonBId!;
      const loId = aIsLo ? s.teamSeasonAId! : s.teamSeasonBId!;
      const hiId = aIsLo ? s.teamSeasonBId! : s.teamSeasonAId!;
      const key = `${s.week}|${loId}|${hiId}`;
      const g = groups.get(key) ?? { loId, hiId, setsLo: 0, setsHi: 0, gamesLo: 0, gamesHi: 0, hasResult: false };
      // Oriented players: whose player represents the canonical lo team in this set.
      const pLo = aIsLo ? s.playerAId : s.playerBId;
      const pHi = aIsLo ? s.playerBId : s.playerAId;
      if ((s.status === "CONFIRMED" || s.status === "FORFEIT") && s.matchId) {
        const m = mById.get(s.matchId);
        if (m) {
          g.hasResult = true;
          if (m.winnerId === pLo) g.setsLo++; else if (m.winnerId === pHi) g.setsHi++;
          g.gamesLo += m.playerAId === pLo ? m.gamesWonA : m.gamesWonB;
          g.gamesHi += m.playerAId === pLo ? m.gamesWonB : m.gamesWonA;
        }
      }
      groups.set(key, g);
    }
    meetings.push(...groups.values());
  }

  // setsToWin only informs future refinements; a meeting with any confirmed set counts as
  // played for the grid (partial in-progress sets still show a real score).
  void setsToWin;
  return meetings;
}

export async function getSeasonGrid(seasonName: string): Promise<SeasonGrid | null> {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    select: { id: true, name: true, format: true, setsToWin: true },
  });
  if (!season) return null;

  const conferences = await prisma.conference.findMany({
    where: { seasonId: season.id },
    select: {
      id: true, name: true,
      teamSeasons: { select: { id: true, seed: true, team: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });
  const confOf = new Map<string, { id: string; name: string }>();
  const nameOf = new Map<string, string>();
  for (const c of conferences) {
    for (const t of c.teamSeasons) {
      confOf.set(t.id, { id: c.id, name: c.name });
      nameOf.set(t.id, t.team.name);
    }
  }

  const meetings = await loadMeetings(season.id, season.setsToWin);

  // Index meetings by unordered pair, summing across repeat encounters (double RR).
  interface PairAgg { meetings: number; setsLo: number; setsHi: number; gamesLo: number; gamesHi: number; played: boolean }
  const pairs = new Map<string, PairAgg>();
  const crossConf: CrossMeeting[] = [];
  let playedMeetings = 0;
  for (const mt of meetings) {
    if (mt.hasResult) playedMeetings++;
    const ca = confOf.get(mt.loId), cb = confOf.get(mt.hiId);
    if (ca && cb && ca.id !== cb.id) {
      // Cross-conference: not part of either conference's round-robin grid.
      crossConf.push({
        aName: nameOf.get(mt.loId) ?? "?", bName: nameOf.get(mt.hiId) ?? "?",
        aConf: ca.name, bConf: cb.name, setsA: mt.setsLo, setsB: mt.setsHi, week: null,
      });
      continue;
    }
    const key = `${mt.loId}|${mt.hiId}`;
    const agg = pairs.get(key) ?? { meetings: 0, setsLo: 0, setsHi: 0, gamesLo: 0, gamesHi: 0, played: false };
    agg.meetings++;
    agg.setsLo += mt.setsLo; agg.setsHi += mt.setsHi;
    agg.gamesLo += mt.gamesLo; agg.gamesHi += mt.gamesHi;
    if (mt.hasResult) agg.played = true;
    pairs.set(key, agg);
  }

  const cellFor = (rowId: string, colId: string): GridCell | null => {
    const aIsLo = rowId < colId;
    const key = aIsLo ? `${rowId}|${colId}` : `${colId}|${rowId}`;
    const agg = pairs.get(key);
    if (!agg) return null;
    return {
      meetings: agg.meetings,
      setsFor: aIsLo ? agg.setsLo : agg.setsHi,
      setsAgainst: aIsLo ? agg.setsHi : agg.setsLo,
      gamesFor: aIsLo ? agg.gamesLo : agg.gamesHi,
      gamesAgainst: aIsLo ? agg.gamesHi : agg.gamesLo,
      state: agg.played ? "played" : "scheduled",
    };
  };

  // Total played meetings per team (incl. cross-conf) -- lets the TO sanity-check the grid
  // against a known standings record ("this team went 6-2, so it should show 8 meetings").
  const totalPlayedByTeam = new Map<string, number>();
  for (const mt of meetings) {
    if (!mt.hasResult) continue;
    totalPlayedByTeam.set(mt.loId, (totalPlayedByTeam.get(mt.loId) ?? 0) + 1);
    totalPlayedByTeam.set(mt.hiId, (totalPlayedByTeam.get(mt.hiId) ?? 0) + 1);
  }

  let missingPairs = 0;
  const confGrids: ConferenceGrid[] = conferences
    .filter((c) => c.teamSeasons.length > 0)
    .map((c) => {
      const ordered = [...c.teamSeasons].sort((a, b) => a.seed - b.seed || a.team.name.localeCompare(b.team.name));
      const teamIds = ordered.map((t) => t.id);
      const rows = ordered.map((t) => ({
        teamSeasonId: t.id,
        cells: teamIds.map((colId) => (colId === t.id ? null : cellFor(t.id, colId))),
      }));
      const teams: GridTeam[] = ordered.map((t, i) => {
        let played = 0, scheduled = 0;
        for (const cell of rows[i].cells) {
          if (!cell) continue;
          if (cell.state === "played") played++; else scheduled++;
        }
        const possible = ordered.length - 1;
        const missing = Math.max(0, possible - played - scheduled);
        missingPairs += missing;
        return {
          teamSeasonId: t.id, name: t.team.name, seed: t.seed,
          opponentsPlayed: played, opponentsScheduled: scheduled, missing, possibleOpponents: possible,
          totalMeetings: totalPlayedByTeam.get(t.id) ?? 0,
        };
      });
      return { conferenceId: c.id, conferenceName: c.name, teams, rows };
    });

  // Each blank cell is counted once per row above (both (X,Y) and (Y,X) are blank), so the
  // number of distinct missing PAIRS is half the summed per-team missing counts.
  missingPairs = Math.round(missingPairs / 2);

  return {
    seasonName: season.name,
    format: season.format,
    conferences: confGrids,
    crossConf,
    totals: {
      teams: confOf.size,
      playedMeetings,
      missingPairs,
    },
  };
}
