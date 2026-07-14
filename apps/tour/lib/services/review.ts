// Week-by-week review-and-correct hub (admin). Reads TourSet DIRECTLY and groups
// into week -> matchup(s) -> pairings for one team, so it works for BOTH live
// seasons (sets linked to a Matchup/Week) AND imported flat seasons like TT4
// (loose TourSets carrying their own `week`, no Matchup/Week rows -- which is why
// the Week/Matchup-based audit, console, and grid show nothing for them).
//
// Truth is the sets; everything here is derive-on-read. The derived lineup for a
// week comes from the RosterMove log (rosterForWeek). Read-only; edits go through
// the existing services (report / roster-ops) from the page.
import { prisma } from "../db";
import { rosterForWeek, subOnlyKeySet } from "./roster-ops";
import { reportSet, dqSet, rollupMatchup } from "./report";

// A pairing seen from the SELECTED team's side ("our" = the team being reviewed).
export interface ReviewPair {
  setId: string;
  ourSlot: "A" | "B"; // which side of the underlying set is "our" team (for score mapping)
  ourPlayerId: string;
  ourName: string;
  ourSeed: number;
  ourIsSub: boolean;
  theirPlayerId: string;
  theirName: string;
  theirSeed: number;
  ourGames: number | null;
  theirGames: number | null;
  bestOf: number;
  status: string;
  reported: boolean; // has a recorded result
  seedGap: number | null;
  offSeed: boolean; // |ourSeed - theirSeed| > 2 -- the +/-2 pairing rule
  reassignedFrom: string | null;
}

export interface ReviewMatchup {
  key: string;
  matchupId: string | null; // present for live seasons -> deep-links to the console
  opponentTeamSeasonId: string;
  opponentName: string;
  ourSetsWon: number;
  theirSetsWon: number;
  decided: boolean;
  pairs: ReviewPair[];
  // flags for a quick scan
  noPairs: boolean; // no pairings recorded at all
  short: boolean; // fewer pairings than the team size
  allZero: boolean; // every recorded pairing is 0-0 (nobody actually played)
  offSeedCount: number;
}

export interface ReviewLineupPlayer {
  playerId: string;
  name: string;
  seed: number;
  isCaptain: boolean;
  viaSub: boolean;
}

export interface ReviewWeek {
  week: number; // real week number, or a synthetic slot for playoffs
  label: string;
  isPlayoff: boolean;
  lineup: ReviewLineupPlayer[];
  matchups: ReviewMatchup[];
  offSeedCount: number;
}

export interface SeasonReview {
  seasonName: string;
  teamSize: number;
  teamSeasonId: string;
  teamName: string;
  teams: { teamSeasonId: string; name: string; seed: number }[];
  teamPlayers: { id: string; name: string }[]; // candidates for "who played" fixes on this team
  weeks: ReviewWeek[];
  offSeedTotal: number;
  emptyMatchupCount: number; // matchups with no pairings and/or all-0-0
}

const PLAYOFF_WEEK = 100000; // synthetic slot so playoff buckets sort after regular weeks

interface RawSet {
  id: string;
  week: number | null;
  bracket: string | null;
  teamSeasonAId: string | null;
  teamSeasonBId: string | null;
  playerAId: string;
  playerBId: string;
  seedA: number;
  seedB: number;
  bestOf: number;
  status: string;
  matchId: string | null;
  reassignedFromId: string | null;
  matchup: {
    id: string;
    teamSeasonAId: string;
    teamSeasonBId: string;
    setsWonA: number | null;
    setsWonB: number | null;
    week: { number: number } | null;
  } | null;
}

const isReported = (status: string, matchId: string | null) =>
  status === "CONFIRMED" || status === "FORFEIT" || status === "REPORTED" || matchId != null;

export async function getSeasonReview(seasonName: string, teamSeasonId?: string): Promise<SeasonReview | null> {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    select: { id: true, name: true, teamSize: true },
  });
  if (!season) return null;

  const teamSeasons = await prisma.teamSeason.findMany({
    where: { seasonId: season.id },
    select: { id: true, seed: true, team: { select: { name: true } } },
    orderBy: { seed: "asc" },
  });
  if (!teamSeasons.length) {
    return { seasonName: season.name, teamSize: season.teamSize, teamSeasonId: "", teamName: "", teams: [], teamPlayers: [], weeks: [], offSeedTotal: 0, emptyMatchupCount: 0 };
  }
  const teams = teamSeasons.map((t) => ({ teamSeasonId: t.id, name: t.team.name, seed: t.seed }));
  const tsId = teamSeasonId && teams.some((t) => t.teamSeasonId === teamSeasonId) ? teamSeasonId : teams[0].teamSeasonId;
  const teamName = teams.find((t) => t.teamSeasonId === tsId)!.name;

  // Every set the selected team is in -- flat (teamSeasonA/BId on the set) OR live
  // (the team is on the set's matchup). One query covers both shapes.
  const rawSets = (await prisma.tourSet.findMany({
    where: {
      seasonId: season.id,
      OR: [
        { teamSeasonAId: tsId },
        { teamSeasonBId: tsId },
        { matchup: { teamSeasonAId: tsId } },
        { matchup: { teamSeasonBId: tsId } },
      ],
    },
    select: {
      id: true, week: true, bracket: true, teamSeasonAId: true, teamSeasonBId: true,
      playerAId: true, playerBId: true, seedA: true, seedB: true, bestOf: true, status: true,
      matchId: true, reassignedFromId: true,
      matchup: { select: { id: true, teamSeasonAId: true, teamSeasonBId: true, setsWonA: true, setsWonB: true, week: { select: { number: true } } } },
    },
  })) as RawSet[];

  // Resolve names, scores, and sub chips in bulk.
  const matchIds = rawSets.map((s) => s.matchId).filter((x): x is string => !!x);
  const playerIds = new Set<string>();
  for (const s of rawSets) { playerIds.add(s.playerAId); playerIds.add(s.playerBId); if (s.reassignedFromId) playerIds.add(s.reassignedFromId); }

  // Which weeks exist for this team (from the sets) -> derive the lineup for each.
  const weekOf = (s: RawSet): { week: number; isPlayoff: boolean } => {
    const w = s.week ?? s.matchup?.week?.number ?? null;
    const playoff = (s.bracket != null && s.bracket !== "REGULAR") || w == null;
    return { week: playoff ? PLAYOFF_WEEK : w!, isPlayoff: playoff };
  };
  const regularWeeks = [...new Set(rawSets.map((s) => weekOf(s)).filter((w) => !w.isPlayoff).map((w) => w.week))].sort((a, b) => a - b);
  const hasPlayoff = rawSets.some((s) => weekOf(s).isPlayoff);
  const lineupWeeks = [...regularWeeks];

  const lineupByWeek = new Map<number, ReviewLineupPlayer[]>();
  await Promise.all(
    lineupWeeks.map(async (wk) => {
      const lp = await rosterForWeek(tsId, wk);
      lineupByWeek.set(wk, lp.map((p) => ({ playerId: p.playerId, name: "", seed: p.seed, isCaptain: p.isCaptain, viaSub: p.viaSub })));
    }),
  );
  for (const lps of lineupByWeek.values()) for (const p of lps) playerIds.add(p.playerId);

  const [players, matches, subOnly] = await Promise.all([
    playerIds.size ? prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    matchIds.length ? prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }) : Promise.resolve([]),
    subOnlyKeySet(teamSeasons.map((t) => t.id)),
  ]);
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const teamNameOf = new Map(teams.map((t) => [t.teamSeasonId, t.name]));

  // Group sets into (week, matchup/pair) buckets.
  interface Bucket { week: number; isPlayoff: boolean; matchupId: string | null; opp: string; setsWonA: number | null; setsWonB: number | null; ourSideA: boolean; sets: RawSet[] }
  const buckets = new Map<string, Bucket>();
  for (const s of rawSets) {
    const { week, isPlayoff } = weekOf(s);
    const tsA = s.matchup?.teamSeasonAId ?? s.teamSeasonAId;
    const tsB = s.matchup?.teamSeasonBId ?? s.teamSeasonBId;
    if (!tsA || !tsB) continue; // can't place a set with an unknown side
    const ourSideA = tsA === tsId;
    const opp = ourSideA ? tsB : tsA;
    const key = s.matchup?.id ?? `${week}|${[tsA, tsB].sort().join("~")}`;
    let b = buckets.get(key);
    if (!b) {
      b = { week, isPlayoff, matchupId: s.matchup?.id ?? null, opp, setsWonA: s.matchup?.setsWonA ?? null, setsWonB: s.matchup?.setsWonB ?? null, ourSideA, sets: [] };
      buckets.set(key, b);
    }
    b.sets.push(s);
  }

  // Assemble weeks.
  const weekKeys = [...new Set([...regularWeeks, ...(hasPlayoff ? [PLAYOFF_WEEK] : [])])].sort((a, b) => a - b);
  const weeks: ReviewWeek[] = weekKeys.map((wk) => {
    const isPlayoff = wk === PLAYOFF_WEEK;
    const wkBuckets = [...buckets.values()].filter((b) => b.week === wk).sort((a, b) => (teamNameOf.get(a.opp) ?? "").localeCompare(teamNameOf.get(b.opp) ?? ""));
    const matchups: ReviewMatchup[] = wkBuckets.map((b) => {
      const pairs: ReviewPair[] = b.sets
        .map((s) => {
          const our = b.ourSideA ? "A" : "B";
          const ourPlayerId = our === "A" ? s.playerAId : s.playerBId;
          const theirPlayerId = our === "A" ? s.playerBId : s.playerAId;
          const ourSeed = our === "A" ? s.seedA : s.seedB;
          const theirSeed = our === "A" ? s.seedB : s.seedA;
          const m = s.matchId ? matchById.get(s.matchId) : undefined;
          // Align the canonical Match's games to the set's team A by player id, then to our side.
          const teamAGames = m ? (m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB) : null;
          const teamBGames = m ? (m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA) : null;
          const ourGames = teamAGames == null ? null : our === "A" ? teamAGames : teamBGames;
          const theirGames = teamAGames == null ? null : our === "A" ? teamBGames : teamAGames;
          const seedGap = Math.abs(ourSeed - theirSeed);
          return {
            setId: s.id,
            ourSlot: our as "A" | "B",
            ourPlayerId, ourName: nameOf.get(ourPlayerId) ?? ourPlayerId, ourSeed,
            ourIsSub: subOnly.has(`${tsId}|${ourPlayerId}`),
            theirPlayerId, theirName: nameOf.get(theirPlayerId) ?? theirPlayerId, theirSeed,
            ourGames, theirGames, bestOf: s.bestOf, status: s.status,
            reported: isReported(s.status, s.matchId),
            seedGap, offSeed: seedGap > 2,
            reassignedFrom: s.reassignedFromId ? nameOf.get(s.reassignedFromId) ?? null : null,
          };
        })
        .sort((a, b2) => a.ourSeed - b2.ourSeed);

      // Rolled-up team result: use the matchup's persisted result when present, else
      // count confirmed sets from our side.
      let ourSetsWon: number, theirSetsWon: number, decided: boolean;
      if (b.matchupId && b.setsWonA != null && b.setsWonB != null) {
        ourSetsWon = b.ourSideA ? b.setsWonA : b.setsWonB;
        theirSetsWon = b.ourSideA ? b.setsWonB : b.setsWonA;
        decided = true;
      } else {
        ourSetsWon = pairs.filter((p) => p.reported && p.ourGames != null && p.theirGames != null && p.ourGames > p.theirGames).length;
        theirSetsWon = pairs.filter((p) => p.reported && p.ourGames != null && p.theirGames != null && p.theirGames > p.ourGames).length;
        decided = false;
      }

      const recorded = pairs.filter((p) => p.reported);
      const offSeedCount = pairs.filter((p) => p.offSeed).length;
      return {
        key: b.matchupId ?? `${b.week}|${b.opp}`,
        matchupId: b.matchupId,
        opponentTeamSeasonId: b.opp,
        opponentName: teamNameOf.get(b.opp) ?? "?",
        ourSetsWon, theirSetsWon, decided,
        pairs,
        noPairs: pairs.length === 0,
        short: pairs.length > 0 && pairs.length < season.teamSize,
        allZero: recorded.length > 0 && recorded.every((p) => (p.ourGames ?? 0) === 0 && (p.theirGames ?? 0) === 0),
        offSeedCount,
      };
    });

    const rawLineup = lineupByWeek.get(wk) ?? [];
    const lineup = rawLineup.map((p) => ({ ...p, name: nameOf.get(p.playerId) ?? p.playerId }));
    return {
      week: wk,
      label: isPlayoff ? "Playoffs" : `Week ${wk}`,
      isPlayoff,
      lineup,
      matchups,
      offSeedCount: matchups.reduce((n, m) => n + m.offSeedCount, 0),
    };
  });

  const offSeedTotal = weeks.reduce((n, w) => n + w.offSeedCount, 0);
  const emptyMatchupCount = weeks.reduce((n, w) => n + w.matchups.filter((m) => m.noPairs || m.allZero).length, 0);

  // Candidate players for "who played" fixes on this team: everyone who has played a
  // set for it plus anyone in its derived lineup (covers subs pulled in mid-season).
  const teamPlayerIds = new Set<string>();
  for (const w of weeks) {
    for (const m of w.matchups) for (const p of m.pairs) teamPlayerIds.add(p.ourPlayerId);
    for (const lp of w.lineup) teamPlayerIds.add(lp.playerId);
  }
  const teamPlayers = [...teamPlayerIds]
    .map((id) => ({ id, name: nameOf.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { seasonName: season.name, teamSize: season.teamSize, teamSeasonId: tsId, teamName, teams, teamPlayers, weeks, offSeedTotal, emptyMatchupCount };
}

// Correct who played a set -- works on ANY status (unplayed OR already recorded),
// flat OR live sets. The site's built-in reassign is unplayed-only; this fills that
// gap. If the set had a result we rebuild it for the new player with the SAME
// team-relative score (0-0 stays a DQ). `reassignedFromId` remembers the original.
export async function reviewReassignPlayer(setId: string, side: "our" | "their", ourTeamSeasonId: string, newPlayerId: string) {
  if (!newPlayerId) throw new Error("Pick a player.");
  const set = await prisma.tourSet.findUnique({ where: { id: setId }, include: { matchup: { select: { teamSeasonAId: true } } } });
  if (!set) throw new Error("No such set.");
  // Map our/their to the set's A/B by which side this team is on.
  const tsA = set.matchup?.teamSeasonAId ?? set.teamSeasonAId;
  const ourIsA = tsA != null ? tsA === ourTeamSeasonId : true;
  const slot: "A" | "B" = (side === "our") === ourIsA ? "A" : "B";
  const cur = slot === "A" ? set.playerAId : set.playerBId;
  if (cur === newPlayerId) return { ok: true, changed: false };

  // Capture the current team-relative score before we touch anything.
  let recorded: { aGames: number; bGames: number; zero: boolean } | null = null;
  if (set.matchId) {
    const m = await prisma.match.findUnique({ where: { id: set.matchId }, select: { playerAId: true, gamesWonA: true, gamesWonB: true } });
    if (m) {
      const aGames = m.playerAId === set.playerAId ? m.gamesWonA : m.gamesWonB;
      const bGames = m.playerAId === set.playerAId ? m.gamesWonB : m.gamesWonA;
      recorded = { aGames, bGames, zero: aGames === 0 && bGames === 0 };
    }
    // Players are changing -> the canonical Match must be rebuilt from scratch.
    await prisma.match.delete({ where: { id: set.matchId } });
    await prisma.tourSet.update({ where: { id: setId }, data: { matchId: null, status: "PROPOSED" } });
  }
  await prisma.tourSet.update({
    where: { id: setId },
    data: { ...(slot === "A" ? { playerAId: newPlayerId } : { playerBId: newPlayerId }), reassignedFromId: set.reassignedFromId ?? cur },
  });
  if (recorded) {
    if (recorded.zero) await dqSet(setId);
    else await reportSet(setId, recorded.aGames, recorded.bGames);
  } else if (set.matchupId) {
    await rollupMatchup(set.matchupId);
  }
  return { ok: true, changed: true };
}

// Correct the recorded seed on one side of a set (TourSet.seedA/seedB). This is the
// raw stored seed the pairing shows and the +/-2 off-seed flag reads -- editing it
// clears a bad flag / fixes an imported seed directly. `slot` is the set's A/B side
// (the page maps our/their -> A/B via each pair's ourSlot).
export async function reviewSetSeed(setId: string, slot: "A" | "B", seed: number) {
  if (!Number.isInteger(seed) || seed < 1) throw new Error("Seed must be a whole number >= 1.");
  const set = await prisma.tourSet.findUnique({ where: { id: setId }, select: { id: true } });
  if (!set) throw new Error("No such set.");
  await prisma.tourSet.update({ where: { id: setId }, data: slot === "A" ? { seedA: seed } : { seedB: seed } });
  return { ok: true };
}
