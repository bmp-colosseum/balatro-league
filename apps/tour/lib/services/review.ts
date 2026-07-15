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
  offSeedDismissed: boolean; // off-seed, but a TO marked it intentional (silenced)
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
  week: number; // real week number, or a synthetic slot for a playoff round
  label: string;
  tabLabel: string; // short label for the week stepper
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
  allPlayers: { id: string; name: string }[]; // season-wide -- opponent-side + add-pairing pickers
  weeks: ReviewWeek[];
  offSeedTotal: number;
  emptyMatchupCount: number; // matchups with no pairings and/or all-0-0
}

// A short round abbreviation for a playoff bracket label ("Quarterfinal 2" -> "QF2").
function shortRound(round: string): string {
  const m = /^(quarter|semi)/i.exec(round);
  if (m) {
    const n = (/(\d+)/.exec(round) ?? [])[1] ?? "";
    return (/quarter/i.test(m[1]) ? "QF" : "SF") + n;
  }
  if (/champ|grand|final/i.test(round)) return "Final";
  return round.length > 10 ? round.slice(0, 10) : round;
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
    return { seasonName: season.name, teamSize: season.teamSize, teamSeasonId: "", teamName: "", teams: [], teamPlayers: [], allPlayers: [], weeks: [], offSeedTotal: 0, emptyMatchupCount: 0 };
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
  const lineupWeeks = [...regularWeeks];

  const lineupByWeek = new Map<number, ReviewLineupPlayer[]>();
  await Promise.all(
    lineupWeeks.map(async (wk) => {
      const lp = await rosterForWeek(tsId, wk);
      lineupByWeek.set(wk, lp.map((p) => ({ playerId: p.playerId, name: "", seed: p.seed, isCaptain: p.isCaptain, viaSub: p.viaSub })));
    }),
  );
  for (const lps of lineupByWeek.values()) for (const p of lps) playerIds.add(p.playerId);

  const [players, matches, subOnly, dismissRows] = await Promise.all([
    playerIds.size ? prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    matchIds.length ? prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }) : Promise.resolve([]),
    subOnlyKeySet(teamSeasons.map((t) => t.id)),
    prisma.reviewDismissal.findMany({ where: { seasonId: season.id }, select: { kind: true, targetId: true } }),
  ]);
  const dismissed = new Set(dismissRows.map((d) => `${d.kind}:${d.targetId}`));
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const teamNameOf = new Map(teams.map((t) => [t.teamSeasonId, t.name]));

  // Group sets into (week, matchup/pair) buckets. Flat playoff sets already split by
  // opponent pairing (week = PLAYOFF_WEEK); we give each its own round tab below.
  interface Bucket { week: number; isPlayoff: boolean; bracket: string | null; matchupId: string | null; opp: string; setsWonA: number | null; setsWonB: number | null; ourSideA: boolean; sets: RawSet[] }
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
      b = { week, isPlayoff, bracket: s.bracket, matchupId: s.matchup?.id ?? null, opp, setsWonA: s.matchup?.setsWonA ?? null, setsWonB: s.matchup?.setsWonB ?? null, ourSideA, sets: [] };
      buckets.set(key, b);
    }
    b.sets.push(s);
  }

  const buildMatchup = (b: Bucket): ReviewMatchup => {
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
          seedGap, offSeed: seedGap > 2, offSeedDismissed: seedGap > 2 && dismissed.has(`OFF_SEED:${s.id}`),
          reassignedFrom: s.reassignedFromId ? nameOf.get(s.reassignedFromId) ?? null : null,
        };
      })
      .sort((a, b2) => a.ourSeed - b2.ourSeed);

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
      offSeedCount: pairs.filter((p) => p.offSeed && !p.offSeedDismissed).length,
    };
  };

  const byOpp = (a: Bucket, c: Bucket) => (teamNameOf.get(a.opp) ?? "").localeCompare(teamNameOf.get(c.opp) ?? "");
  const weeks: ReviewWeek[] = [];
  // Regular weeks: matchups grouped by week, lineup derived from the roster-move log.
  for (const wk of regularWeeks) {
    const matchups = [...buckets.values()].filter((b) => !b.isPlayoff && b.week === wk).sort(byOpp).map(buildMatchup);
    const rawLineup = lineupByWeek.get(wk) ?? [];
    const lineup = rawLineup.map((p) => ({ ...p, name: nameOf.get(p.playerId) ?? p.playerId }));
    weeks.push({ week: wk, label: `Week ${wk}`, tabLabel: `W${wk}`, isPlayoff: false, lineup, matchups, offSeedCount: matchups.reduce((n, m) => n + m.offSeedCount, 0) });
  }
  // Playoffs: one tab per round/opponent (not one lumped bucket). Lineup = who actually
  // played that round (from the pairs), like the archive's per-round view.
  const playoffBuckets = [...buckets.values()].filter((b) => b.isPlayoff)
    .sort((a, c) => (a.bracket ?? "").localeCompare(c.bracket ?? "") || byOpp(a, c));
  playoffBuckets.forEach((b, i) => {
    const matchup = buildMatchup(b);
    const oppName = teamNameOf.get(b.opp) ?? "?";
    const round = b.bracket && b.bracket !== "PLAYOFF" && b.bracket !== "REGULAR" ? b.bracket : null;
    const seen = new Set<string>();
    const lineup: ReviewLineupPlayer[] = matchup.pairs
      .filter((p) => (seen.has(p.ourPlayerId) ? false : (seen.add(p.ourPlayerId), true)))
      .map((p) => ({ playerId: p.ourPlayerId, name: p.ourName, seed: p.ourSeed, isCaptain: false, viaSub: p.ourIsSub }))
      .sort((x, y) => x.seed - y.seed);
    weeks.push({
      week: PLAYOFF_WEEK + i,
      label: round ? `${round} vs ${oppName}` : `Playoffs vs ${oppName}`,
      tabLabel: round ? shortRound(round) : "PO",
      isPlayoff: true,
      lineup,
      matchups: [matchup],
      offSeedCount: matchup.offSeedCount,
    });
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

  // Season-wide roster -- candidates for opponent-side reassign and add-pairing pickers.
  const seasonEntries = await prisma.rosterEntry.findMany({
    where: { roster: { teamSeason: { seasonId: season.id } } },
    select: { playerId: true },
  });
  const allIds = [...new Set(seasonEntries.map((e) => e.playerId))];
  const missing = allIds.filter((id) => !nameOf.has(id));
  if (missing.length) {
    const extra = await prisma.player.findMany({ where: { id: { in: missing } }, select: { id: true, displayName: true } });
    for (const p of extra) nameOf.set(p.id, p.displayName);
  }
  const allPlayers = allIds
    .map((id) => ({ id, name: nameOf.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { seasonName: season.name, teamSize: season.teamSize, teamSeasonId: tsId, teamName, teams, teamPlayers, allPlayers, weeks, offSeedTotal, emptyMatchupCount };
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

// Remove a pairing entirely (a spurious/phantom set). Deletes the set and its recorded
// Match; re-rolls the matchup if it's a live one.
export async function reviewRemovePair(setId: string) {
  const set = await prisma.tourSet.findUnique({ where: { id: setId }, select: { matchId: true, matchupId: true } });
  if (!set) throw new Error("No such set.");
  if (set.matchId) await prisma.match.delete({ where: { id: set.matchId } });
  await prisma.tourSet.delete({ where: { id: setId } });
  if (set.matchupId) await rollupMatchup(set.matchupId);
  return { ok: true };
}

// Add a pairing to a matchup by cloning an existing set's context (week / matchup /
// team sides / bracket / bestOf) -- so orientation and season linkage always match the
// rest of the matchup -- and setting the two chosen players + seeds. New set is unplayed.
export async function reviewAddPair(templateSetId: string, ourTeamSeasonId: string, ourPlayerId: string, theirPlayerId: string, ourSeed: number, theirSeed: number) {
  if (!ourPlayerId || !theirPlayerId) throw new Error("Pick both players.");
  if (ourPlayerId === theirPlayerId) throw new Error("Pick two different players.");
  if (!Number.isInteger(ourSeed) || ourSeed < 1 || !Number.isInteger(theirSeed) || theirSeed < 1) throw new Error("Seeds must be whole numbers >= 1.");
  const t = await prisma.tourSet.findUnique({ where: { id: templateSetId }, include: { matchup: { select: { teamSeasonAId: true } } } });
  if (!t) throw new Error("No template set to copy the matchup from.");
  const tsA = t.matchup?.teamSeasonAId ?? t.teamSeasonAId;
  const ourIsA = tsA != null ? tsA === ourTeamSeasonId : true;
  const created = await prisma.tourSet.create({
    data: {
      matchupId: t.matchupId,
      seasonId: t.seasonId,
      week: t.week,
      bracket: t.bracket,
      teamSeasonAId: t.teamSeasonAId,
      teamSeasonBId: t.teamSeasonBId,
      playerAId: ourIsA ? ourPlayerId : theirPlayerId,
      playerBId: ourIsA ? theirPlayerId : ourPlayerId,
      seedA: ourIsA ? ourSeed : theirSeed,
      seedB: ourIsA ? theirSeed : ourSeed,
      bestOf: t.bestOf,
      status: "PROPOSED",
    },
  });
  if (t.matchupId) await rollupMatchup(t.matchupId);
  return { ok: true, id: created.id };
}

export type CorrectionKind = "OFF_SEED" | "SHORT" | "ALL_ZERO";

export interface Correction {
  key: string; // dismiss key = `${kind}:${targetId}`
  kind: CorrectionKind;
  targetId: string; // TourSet id (OFF_SEED) or matchup/bucket key (SHORT/ALL_ZERO)
  dismissed: boolean; // a TO silenced it (marked intentional)
  teamSeasonId: string | null; // jump target for the review link
  week: number | null;
  weekLabel: string;
  title: string;
  detail: string;
  gap: number | null; // OFF_SEED only
}

export interface SeasonCorrections {
  seasonName: string;
  active: Correction[];
  silenced: Correction[];
  activeByKind: { OFF_SEED: number; SHORT: number; ALL_ZERO: number };
}

const KIND_ORDER: Record<CorrectionKind, number> = { OFF_SEED: 0, SHORT: 1, ALL_ZERO: 2 };

// The whole-season "corrections needed" punch-list: every off-seed pairing (>2), plus
// short matchups (fewer pairings than the team size) and all-0-0 matchups, across ALL
// teams -- each silenceable (a TO can mark an intentional anomaly so it drops off).
export async function getSeasonCorrections(seasonName: string): Promise<SeasonCorrections | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true, teamSize: true } });
  if (!season) return null;
  const sets = await prisma.tourSet.findMany({
    where: { seasonId: season.id },
    select: {
      id: true, week: true, bracket: true, seedA: true, seedB: true, playerAId: true, playerBId: true,
      teamSeasonAId: true, teamSeasonBId: true, status: true, matchId: true,
      matchup: { select: { id: true, teamSeasonAId: true, teamSeasonBId: true, week: { select: { number: true } } } },
    },
  });
  const playerIds = [...new Set(sets.flatMap((s) => [s.playerAId, s.playerBId]))];
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const [teamRows, playerRows, matchRows, dismissRows] = await Promise.all([
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, select: { id: true, team: { select: { name: true } } } }),
    playerIds.length ? prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    matchIds.length ? prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, gamesWonA: true, gamesWonB: true } }) : Promise.resolve([]),
    prisma.reviewDismissal.findMany({ where: { seasonId: season.id }, select: { kind: true, targetId: true } }),
  ]);
  const teamName = new Map(teamRows.map((t) => [t.id, t.team.name]));
  const nm = new Map(playerRows.map((p) => [p.id, p.displayName]));
  const matchById = new Map(matchRows.map((m) => [m.id, m]));
  const dismissed = new Set(dismissRows.map((d) => `${d.kind}:${d.targetId}`));
  const tn = (id: string | null | undefined) => (id && teamName.get(id)) || "?";

  const weekOf = (s: (typeof sets)[number]) => {
    const wk = s.week ?? s.matchup?.week?.number ?? null;
    const playoff = (s.bracket != null && s.bracket !== "REGULAR") || wk == null;
    return { week: playoff ? null : wk, label: playoff ? (s.bracket && s.bracket !== "PLAYOFF" ? s.bracket : "Playoffs") : `W${wk}` };
  };

  const corrections: Correction[] = [];

  // OFF_SEED -- per pairing whose seeds are >2 apart.
  for (const s of sets) {
    const gap = Math.abs(s.seedA - s.seedB);
    if (gap <= 2) continue;
    const a = s.matchup?.teamSeasonAId ?? s.teamSeasonAId;
    const b = s.matchup?.teamSeasonBId ?? s.teamSeasonBId;
    const w = weekOf(s);
    corrections.push({
      key: `OFF_SEED:${s.id}`, kind: "OFF_SEED", targetId: s.id, dismissed: dismissed.has(`OFF_SEED:${s.id}`),
      teamSeasonId: a ?? b ?? null, week: w.week, weekLabel: w.label, gap,
      title: `${tn(a)} #${s.seedA} ${nm.get(s.playerAId) ?? "?"} vs #${s.seedB} ${nm.get(s.playerBId) ?? "?"} ${tn(b)}`,
      detail: `${w.label} -- seeds ${gap} apart`,
    });
  }

  // Matchup-level -- group sets into buckets, flag SHORT and all-0-0.
  interface G { key: string; week: number | null; label: string; ts: string | null; aTeam: string; bTeam: string; count: number; recorded: number; zeroAll: boolean }
  const groups = new Map<string, G>();
  for (const s of sets) {
    const a = s.matchup?.teamSeasonAId ?? s.teamSeasonAId;
    const b = s.matchup?.teamSeasonBId ?? s.teamSeasonBId;
    if (!a || !b) continue;
    const w = weekOf(s);
    const key = s.matchup?.id ?? `${w.label}|${[a, b].sort().join("~")}`;
    let g = groups.get(key);
    if (!g) { g = { key, week: w.week, label: w.label, ts: a, aTeam: tn(a), bTeam: tn(b), count: 0, recorded: 0, zeroAll: true }; groups.set(key, g); }
    g.count++;
    const m = s.matchId ? matchById.get(s.matchId) : undefined;
    if (isReported(s.status, s.matchId)) {
      g.recorded++;
      if (m ? m.gamesWonA !== 0 || m.gamesWonB !== 0 : false) g.zeroAll = false;
    }
  }
  for (const g of groups.values()) {
    if (g.count < season.teamSize) {
      const key = `SHORT:${g.key}`;
      corrections.push({ key, kind: "SHORT", targetId: g.key, dismissed: dismissed.has(key), teamSeasonId: g.ts, week: g.week, weekLabel: g.label, gap: null, title: `${g.aTeam} vs ${g.bTeam}`, detail: `${g.label} -- ${g.count}/${season.teamSize} pairings recorded` });
    }
    if (g.recorded > 0 && g.zeroAll) {
      const key = `ALL_ZERO:${g.key}`;
      corrections.push({ key, kind: "ALL_ZERO", targetId: g.key, dismissed: dismissed.has(key), teamSeasonId: g.ts, week: g.week, weekLabel: g.label, gap: null, title: `${g.aTeam} vs ${g.bTeam}`, detail: `${g.label} -- every recorded set is 0-0` });
    }
  }

  const order = (a: Correction, b: Correction) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.gap ?? 0) - (a.gap ?? 0) || (a.week ?? 999) - (b.week ?? 999) || a.title.localeCompare(b.title);
  const active = corrections.filter((c) => !c.dismissed).sort(order);
  const silenced = corrections.filter((c) => c.dismissed).sort(order);
  return {
    seasonName: season.name,
    active,
    silenced,
    activeByKind: {
      OFF_SEED: active.filter((c) => c.kind === "OFF_SEED").length,
      SHORT: active.filter((c) => c.kind === "SHORT").length,
      ALL_ZERO: active.filter((c) => c.kind === "ALL_ZERO").length,
    },
  };
}

// Silence a flag (mark an intentional anomaly) / un-silence it. Idempotent.
export async function reviewDismiss(seasonName: string, kind: string, targetId: string, reason?: string, by?: string) {
  if (!["OFF_SEED", "SHORT", "ALL_ZERO"].includes(kind)) throw new Error("Unknown flag kind.");
  if (!targetId) throw new Error("Nothing to silence.");
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error("No such season.");
  await prisma.reviewDismissal.upsert({
    where: { seasonId_kind_targetId: { seasonId: season.id, kind, targetId } },
    create: { seasonId: season.id, kind, targetId, reason: reason ?? null, createdBy: by ?? null },
    update: { reason: reason ?? null },
  });
  return { ok: true };
}

export async function reviewUndismiss(seasonName: string, kind: string, targetId: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error("No such season.");
  await prisma.reviewDismissal.deleteMany({ where: { seasonId: season.id, kind, targetId } });
  return { ok: true };
}
