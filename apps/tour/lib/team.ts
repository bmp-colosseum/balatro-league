// A team's season view: roster (seeds, captain) + each player's set/game record
// that season, with team totals. Derived from the imported sets.
import { prisma } from "./db";
import { getSeasonStandings } from "./standings";
import { seedAtWeekResolver, subOnlyKeySet, deriveLineup, captainAtWeek } from "./services/roster-ops";
import { regularWeekCount, windowLabel, playoffFieldSize } from "./services/playoff-weeks";

export interface TeamPlacement {
  placement: number; // 1-based rank within its conference group
  groupSize: number;
  conference: string;
  matchupsW: number;
  matchupsL: number;
}

// A team's final standing (placement within its conference) + matchup (week)
// record — DERIVED from getSeasonStandings (derive-on-read rule), not imported.
export async function getTeamPlacement(teamSeasonId: string, seasonName: string): Promise<TeamPlacement | null> {
  const st = await getSeasonStandings(seasonName);
  if (!st) return null;
  for (const g of st.groups) {
    const i = g.rows.findIndex((r) => r.teamSeasonId === teamSeasonId);
    if (i >= 0) {
      const r = g.rows[i];
      return { placement: i + 1, groupSize: g.rows.length, conference: g.conferenceName, matchupsW: r.matchupsW, matchupsL: r.matchupsL };
    }
  }
  return null;
}

// Placement + matchup record for every team-season (all seasons), for the LB.
export async function getTeamPlacements(): Promise<Map<string, TeamPlacement>> {
  const seasons = await prisma.tourSeason.findMany({ select: { name: true } });
  const map = new Map<string, TeamPlacement>();
  for (const s of seasons) {
    const st = await getSeasonStandings(s.name);
    if (!st) continue;
    for (const g of st.groups) {
      g.rows.forEach((r, i) => {
        map.set(r.teamSeasonId, { placement: i + 1, groupSize: g.rows.length, conference: g.conferenceName, matchupsW: r.matchupsW, matchupsL: r.matchupsL });
      });
    }
  }
  return map;
}

export interface TeamPlayerLine {
  playerId: string;
  name: string;
  discordId: string | null;
  seed: number; // effective seed at the end of the regular season (reflects re-seeds)
  draftSeed: number; // base draft seed
  reseeded: boolean; // true when the effective seed differs from the draft seed
  seedChain: number[]; // full seed path over the season, e.g. [5, 3, 7] (draft → re-seeds)
  isSub: boolean; // temporary fill-in (SUB stints only, no permanent arrival) -- not a seed-holder
  subWeeks: string | null; // human window(s) of their stints, e.g. "W3" or "W2-4, W7"
  departed: boolean; // a permanent member who left / was permanently subbed out by lastWeek (keeps stats, not an active seat)
  isCaptain: boolean;
  isCoCaptain: boolean;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
}

export interface TeamSeasonView {
  teamSeasonId: string;
  teamName: string;
  seasonName: string;
  conferenceName: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  playoff: { setW: number; setL: number; gameW: number; gameL: number }; // post-season (regular is the default)
  players: TeamPlayerLine[];
}

export interface TeamSeasonRow {
  teamSeasonId: string;
  teamName: string;
  seasonName: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  isChampion: boolean;
}

// All team-seasons ranked by set win % — the all-time team leaderboard.
export async function getAllTimeTeams(): Promise<TeamSeasonRow[]> {
  const teamSeasons = await prisma.teamSeason.findMany({
    include: { team: true, season: true, rosters: { include: { entries: true } } },
  });
  const tsByPlayerSeason = new Map<string, string>();
  const info = new Map<string, { teamName: string; seasonName: string }>();
  for (const ts of teamSeasons) {
    info.set(ts.id, { teamName: ts.team.name, seasonName: ts.season.name });
    for (const r of ts.rosters) for (const e of r.entries) tsByPlayerSeason.set(`${e.playerId}|${ts.seasonId}`, ts.id);
  }

  const sets = await prisma.tourSet.findMany({
    where: { seasonId: { not: null }, bracket: "REGULAR" }, // all-time team records = regular season
    select: { playerAId: true, playerBId: true, teamSeasonAId: true, teamSeasonBId: true, matchId: true, seasonId: true },
  });
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const mById = new Map(matches.map((m) => [m.id, m]));

  const acc = new Map<string, { setW: number; setL: number; gameW: number; gameL: number }>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      acc.set(id, a);
    }
    return a;
  };
  for (const s of sets) {
    const m = s.matchId ? mById.get(s.matchId) : undefined;
    if (!m) continue;
    for (const pid of [s.playerAId, s.playerBId]) {
      // Credit the set to the team the player actually played it for (a cross-team sub is on
      // two teams that season); fall back to the season's roster team for legacy untagged sets.
      const tsId = (pid === s.playerAId ? s.teamSeasonAId : s.teamSeasonBId) ?? tsByPlayerSeason.get(`${pid}|${s.seasonId}`);
      if (!tsId) continue;
      const a = get(tsId);
      const gFor = m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
      const gAg = m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
      a.gameW += gFor;
      a.gameL += gAg;
      if (m.winnerId === pid) a.setW++;
      else if (m.winnerId) a.setL++;
    }
  }

  const finals = await prisma.playoffSeries.findMany({
    where: { round: "FINAL", winnerTeamSeasonId: { not: null } },
    select: { winnerTeamSeasonId: true },
  });
  const champs = new Set(finals.map((f) => f.winnerTeamSeasonId));

  const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);
  return [...acc.entries()]
    .map(([id, a]) => ({
      teamSeasonId: id,
      teamName: info.get(id)?.teamName ?? id,
      seasonName: info.get(id)?.seasonName ?? "",
      ...a,
      isChampion: champs.has(id),
    }))
    .sort((x, y) => rate(y.setW, y.setL) - rate(x.setW, x.setL) || y.setW - x.setW);
}

export async function getTeamSeason(id: string): Promise<TeamSeasonView | null> {
  const ts = await prisma.teamSeason.findUnique({
    where: { id },
    include: { team: true, season: true, conference: true, rosters: { include: { entries: true } } },
  });
  if (!ts) return null;

  const entryByPlayer = new Map<string, { seed: number; isCaptain: boolean; isCoCaptain: boolean }>();
  for (const r of ts.rosters) {
    for (const e of r.entries) {
      const prev = entryByPlayer.get(e.playerId);
      if (!prev) entryByPlayer.set(e.playerId, { seed: e.seed, isCaptain: e.isCaptain, isCoCaptain: e.isCoCaptain });
      else if (e.isCoCaptain && !prev.isCoCaptain) prev.isCoCaptain = true;
    }
  }
  const playerIds = [...entryByPlayer.keys()];

  const [players, sets] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true, discordId: true } }),
    prisma.tourSet.findMany({
      where: { seasonId: ts.seasonId, bracket: "REGULAR", OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }] },
      // Live sets carry no week of their own -- join the matchup's so lastWeek is real.
      // teamSeason side ids let us credit a set to the team the player actually played FOR --
      // a cross-team sub (a member of one team covering another) must not leak stats across.
      select: { playerAId: true, playerBId: true, teamSeasonAId: true, teamSeasonBId: true, matchId: true, week: true, matchup: { select: { week: { select: { number: true } } } } },
    }),
  ]);
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const didById = new Map(players.map((p) => [p.id, p.discordId]));
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const mById = new Map(matches.map((m) => [m.id, m]));

  const acc = new Map<string, { setW: number; setL: number; gameW: number; gameL: number }>();
  const get = (pid: string) => {
    let a = acc.get(pid);
    if (!a) {
      a = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      acc.set(pid, a);
    }
    return a;
  };
  for (const s of sets) {
    const m = s.matchId ? mById.get(s.matchId) : undefined;
    if (!m) continue;
    for (const pid of [s.playerAId, s.playerBId]) {
      if (!entryByPlayer.has(pid)) continue;
      // Only count the set if the player played it FOR this team (cross-team subs keep an
      // entry on both teams). Null side id = legacy import without team tags -> count as before.
      const setTeam = pid === s.playerAId ? s.teamSeasonAId : s.teamSeasonBId;
      if (setTeam != null && setTeam !== id) continue;
      const a = get(pid);
      const gFor = m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
      const gAg = m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
      a.gameW += gFor;
      a.gameL += gAg;
      if (m.winnerId === pid) a.setW++;
      else if (m.winnerId) a.setL++;
    }
  }

  // Effective seed reflects mid-season re-seeds (RESEED moves), read at the last regular week.
  const seedAt = await seedAtWeekResolver([id]);
  const lastWeek = Math.max(1, ...sets.map((s) => s.week ?? s.matchup?.week.number ?? 0));
  // Season-wide regular-week count -- labels playoff pseudo-weeks (> this) as QF/Semi/Final.
  const regularWeeks = (await regularWeekCount(ts.seasonId)) || lastWeek;
  const playoffField = await playoffFieldSize(ts.seasonId);

  // Full seed path per player over the regular season: draft seed + each re-seed (in week
  // order) up to the last regular week — so a multi-step re-seed reads #5 → #3 → #7.
  const seedMoves = await prisma.rosterMove.findMany({
    where: { teamSeasonId: id, kind: { in: ["DRAFTED", "RESEED"] } },
    orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
    select: { playerId: true, kind: true, seed: true, effectiveWeek: true },
  });

  // Who is a temporary SUB (stints only, no permanent DRAFTED/ADDED arrival)? They keep a
  // RosterEntry for stat attribution, but they never held a seed -- show them as subs with
  // their stint weeks, not as seed-N members.
  const memberMoves = await prisma.rosterMove.findMany({
    where: { teamSeasonId: id, kind: { in: ["DRAFTED", "ADDED", "SUB"] } },
    orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
    select: { playerId: true, kind: true, effectiveWeek: true, untilWeek: true },
  });
  const hasArrival = new Set(memberMoves.filter((m) => m.kind !== "SUB").map((m) => m.playerId));
  const stintsOf = new Map<string, string[]>();
  for (const m of memberMoves) {
    if (m.kind !== "SUB" || hasArrival.has(m.playerId)) continue;
    const arr = stintsOf.get(m.playerId) ?? [];
    arr.push(windowLabel(regularWeeks, playoffField, m.effectiveWeek, m.untilWeek));
    stintsOf.set(m.playerId, arr);
  }
  // All moves once -- drives both the replacement check (here) and the departed check (below).
  const allMoves = await prisma.rosterMove.findMany({
    where: { teamSeasonId: id },
    orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
  });
  // A "replacement" came in via a permanent sub (ADDED for someone). Their seed history must
  // ignore any DRAFTED move: the importer records every final-roster member as DRAFTED, so a
  // replacement wrongly picks up a phantom draft seat (Mgods "drafted at #12" when he only ever
  // replaced timetwister at #11). They were never drafted onto this team.
  const replacementIds = new Set(allMoves.filter((m) => m.kind === "ADDED" && m.replacesPlayerId).map((m) => m.playerId));

  const chainOf = new Map<string, number[]>();
  for (const m of seedMoves) {
    if (m.seed == null) continue;
    if (m.kind === "DRAFTED" && replacementIds.has(m.playerId)) continue; // phantom draft for a replacement
    if (m.kind === "RESEED" && m.effectiveWeek > lastWeek) continue;
    const arr = chainOf.get(m.playerId) ?? [];
    if (arr[arr.length - 1] !== m.seed) arr.push(m.seed);
    chainOf.set(m.playerId, arr);
  }

  // Who has left / been permanently subbed out by the last week? Reuse the lineup fold (which
  // drops a player replaced by a permanent sub): any permanent member (has an arrival, not a
  // temp sub) who isn't in the active lineup at lastWeek is departed -- keep their stats, but
  // don't render them as an active seat (that collision put a replaced player back on the
  // roster next to their replacement on the same seed).
  const activeIds = new Set(
    deriveLineup(allMoves, lastWeek, captainAtWeek(allMoves, lastWeek, ts.captainPlayerId ?? "")).map((l) => l.playerId),
  );
  const departedSet = new Set([...hasArrival].filter((pid) => !activeIds.has(pid) && !stintsOf.has(pid)));

  const playerLines: TeamPlayerLine[] = playerIds
    .map((pid) => {
      const e = entryByPlayer.get(pid)!;
      const a = acc.get(pid) ?? { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      const eff = seedAt(id, lastWeek, pid) ?? e.seed;
      // Seed history comes ONLY from real DRAFTED/RESEED moves. A pure replacement (ADDED, no
      // draft) has none -- its base is the seat it holds now, NOT the stale RosterEntry.seed
      // (an import artifact ensureMembership doesn't overwrite). That artifact was the phantom
      // "drafted at 12 -> 11" for a player who was only ever a replacement.
      const chain = (chainOf.get(pid) ?? [eff]).slice();
      if (chain[chain.length - 1] !== eff) chain.push(eff);
      const stints = stintsOf.get(pid);
      return {
        playerId: pid, name: nameById.get(pid) ?? pid, discordId: didById.get(pid) ?? null,
        seed: eff, draftSeed: chain[0], reseeded: chain[0] !== eff, seedChain: chain,
        isSub: !!stints, subWeeks: stints ? stints.join(", ") : null,
        departed: departedSet.has(pid),
        isCaptain: e.isCaptain, isCoCaptain: e.isCoCaptain, ...a,
      };
    })
    // Active seat-holders by seed, then temp subs, then departed/subbed-out players last.
    .sort((x, y) => {
      const rank = (p: TeamPlayerLine) => (p.departed ? 2 : p.isSub ? 1 : 0);
      return rank(x) - rank(y) || x.seed - y.seed;
    });

  const tot = playerLines.reduce(
    (t, p) => ({ setW: t.setW + p.setW, setL: t.setL + p.setL, gameW: t.gameW + p.gameW, gameL: t.gameL + p.gameL }),
    { setW: 0, setL: 0, gameW: 0, gameL: 0 },
  );

  // Post-season record — the roster's playoff sets that season (regular is the default above).
  const poSets = await prisma.tourSet.findMany({
    where: { seasonId: ts.seasonId, bracket: "PLAYOFF", OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }] },
    select: { playerAId: true, playerBId: true, teamSeasonAId: true, teamSeasonBId: true, matchId: true },
  });
  const poMatches = await prisma.match.findMany({
    where: { id: { in: poSets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const poById = new Map(poMatches.map((m) => [m.id, m]));
  const playoff = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
  for (const s of poSets) {
    const m = s.matchId ? poById.get(s.matchId) : undefined;
    if (!m) continue;
    // Count once from the side that played this set FOR this team (a cross-team sub keeps a
    // roster entry on both teams, so "rostered here" alone isn't enough -- check the team tag).
    const aOk = entryByPlayer.has(s.playerAId) && (s.teamSeasonAId == null || s.teamSeasonAId === id);
    const pid = aOk ? s.playerAId : s.playerBId;
    if (!entryByPlayer.has(pid) || (pid === s.playerBId && s.teamSeasonBId != null && s.teamSeasonBId !== id)) continue;
    playoff.gameW += m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
    playoff.gameL += m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
    if (m.winnerId === pid) playoff.setW++;
    else if (m.winnerId) playoff.setL++;
  }

  return {
    teamSeasonId: ts.id,
    teamName: ts.team.name,
    seasonName: ts.season.name,
    conferenceName: ts.conference.name,
    ...tot,
    playoff,
    players: playerLines,
  };
}

export interface TeamMove {
  week: number;
  kind: string;     // ADDED | QUIT | BANNED | REINSTATED | SUB | CAPTAIN_CHANGE
  label: string;
  player: string;
  playerId: string;
  detail?: string;
}

// A team's roster transactions over the season (adds, drops, subs, captain changes) from
// the append-only move log — DRAFTED (the initial roster) and RESEED (seeds are shown in
// the weekly view) are excluded. Ordered by week.
export async function getTeamMoves(teamSeasonId: string): Promise<TeamMove[]> {
  // Fetch ALL moves (incl. DRAFTED) so re-seeds can show "#from -> #to"; DRAFTED itself is
  // the initial roster and isn't listed.
  const moves = await prisma.rosterMove.findMany({
    where: { teamSeasonId },
    orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
  });
  if (!moves.length) return [];
  const pids = [...new Set(moves.flatMap((m) => [m.playerId, m.outPlayerId, m.replacesPlayerId]).filter((x): x is string => !!x))];
  const players = await prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } });
  const pName = new Map(players.map((p) => [p.id, p.displayName]));
  const LABEL: Record<string, string> = { ADDED: "Permanent sub", QUIT: "Left", BANNED: "Banned", REINSTATED: "Reinstated", SUB: "Temp sub", CAPTAIN_CHANGE: "Captain", RESEED: "Re-seed" };
  const replacementIds = new Set(moves.filter((m) => m.kind === "ADDED" && m.replacesPlayerId).map((m) => m.playerId));
  const addedSeat = new Map<string, number>(); // a replacement's inherited seat, to drop redundant self-reseeds
  for (const m of moves) if (m.kind === "ADDED" && m.replacesPlayerId && m.seed != null) addedSeat.set(m.playerId, m.seed);
  const seedNow = new Map<string, number>(); // running seed per player, for re-seed from->to
  const out: TeamMove[] = [];
  for (const m of moves) {
    // A replacement was never drafted -- don't let a phantom DRAFTED seed the "from" of a re-seed.
    if (m.kind === "DRAFTED") { if (m.seed != null && !replacementIds.has(m.playerId)) seedNow.set(m.playerId, m.seed); continue; }
    // Drop a replacement's redundant self-reseed to the seat they already inherited (the ADDED
    // move and the RESEED both say "#11" -- one line, not two).
    if (m.kind === "RESEED" && addedSeat.get(m.playerId) === m.seed) continue;
    let detail: string | undefined;
    if (m.kind === "RESEED") {
      const from = seedNow.get(m.playerId);
      if (m.seed != null) { detail = from != null ? `#${from} → #${m.seed}` : `→ #${m.seed}`; seedNow.set(m.playerId, m.seed); }
    } else if (m.kind === "SUB" && m.outPlayerId) {
      detail = `in for ${pName.get(m.outPlayerId) ?? "?"}${m.untilWeek ? ` (thru W${m.untilWeek})` : ""}`;
    } else if (m.kind === "ADDED" && m.replacesPlayerId) {
      detail = `in for ${pName.get(m.replacesPlayerId) ?? "?"}`;
    } else if (m.reason && !m.reason.startsWith("roster change") && !m.reason.startsWith("ranking")) {
      detail = m.reason;
    }
    out.push({ week: m.effectiveWeek, kind: m.kind, label: LABEL[m.kind] ?? m.kind, player: pName.get(m.playerId) ?? "?", playerId: m.playerId, detail });
  }
  return out;
}

export interface TeamWeekSet {
  player: string;       // this team's player in the set
  playerId: string;
  oppPlayer: string;
  oppPlayerId: string;
  seed: number | null;      // this team's player's roster seed
  oppSeed: number | null;   // opponent player's roster seed
  scoreFor: number;     // this team's player's games won
  scoreAgainst: number;
  win: boolean | null;  // null = tie
}
export interface TeamWeek {
  week: number;
  opponent: string;
  opponentTeamSeasonId: string | null;
  setsFor: number;      // sets this team won that week
  setsAgainst: number;
  sets: TeamWeekSet[];
}

// This team's regular-season schedule, week by week: each week's opponent, the team
// set score, and every player set within it (from this team's perspective). Derived
// from TourSet (week + the team each player played for) — same source as getSeasonWeeks.
export async function getTeamWeeks(teamSeasonId: string): Promise<TeamWeek[]> {
  const sets = await prisma.tourSet.findMany({
    where: {
      bracket: "REGULAR",
      week: { not: null },
      OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }],
    },
    select: { week: true, teamSeasonAId: true, teamSeasonBId: true, playerAId: true, playerBId: true, matchId: true },
  });
  if (!sets.length) return [];

  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const oppTsIds = [...new Set(sets.map((s) => (s.teamSeasonAId === teamSeasonId ? s.teamSeasonBId : s.teamSeasonAId)).filter((x): x is string => !!x))];
  const playerIds = [...new Set(sets.flatMap((s) => [s.playerAId, s.playerBId]))];
  const [matches, oppTeams, players] = await Promise.all([
    prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: oppTsIds } }, include: { team: true } }),
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } }),
  ]);
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const oppName = new Map(oppTeams.map((t) => [t.id, t.team.name]));
  const pName = new Map(players.map((p) => [p.id, p.displayName]));

  // Effective seed AS OF the matchup's week — folds the RosterMove log (RESEED moves,
  // subs) so a mid-season re-seed shows the right number for the weeks it applies to.
  const effSeed = await seedAtWeekResolver([teamSeasonId, ...oppTsIds]);
  const subOnly = await subOnlyKeySet([teamSeasonId, ...oppTsIds]); // subs hold no seed

  // Key by week + opponent: a team usually plays one opponent per week, but this keeps
  // two distinct matchups in the same week from being merged into one row.
  const byWeek = new Map<string, TeamWeek>();
  for (const s of sets) {
    const m = s.matchId ? matchById.get(s.matchId) : undefined;
    if (!m) continue;
    const usIsA = s.teamSeasonAId === teamSeasonId;
    const oppTsId = usIsA ? s.teamSeasonBId : s.teamSeasonAId;
    const usPid = usIsA ? s.playerAId : s.playerBId;
    const oppPid = usIsA ? s.playerBId : s.playerAId;
    // games from our player's perspective
    const ourGames = m.playerAId === usPid ? m.gamesWonA : m.gamesWonB;
    const oppGames = m.playerAId === usPid ? m.gamesWonB : m.gamesWonA;
    const key = `${s.week}|${oppTsId ?? "?"}`;
    let wk = byWeek.get(key);
    if (!wk) {
      wk = { week: s.week!, opponent: oppTsId ? oppName.get(oppTsId) ?? "?" : "?", opponentTeamSeasonId: oppTsId ?? null, setsFor: 0, setsAgainst: 0, sets: [] };
      byWeek.set(key, wk);
    }
    wk.sets.push({
      player: pName.get(usPid) ?? "?",
      playerId: usPid,
      oppPlayer: pName.get(oppPid) ?? "?",
      oppPlayerId: oppPid,
      seed: subOnly.has(`${teamSeasonId}|${usPid}`) ? null : effSeed(teamSeasonId, s.week!, usPid),
      oppSeed: oppTsId && subOnly.has(`${oppTsId}|${oppPid}`) ? null : effSeed(oppTsId, s.week!, oppPid),
      scoreFor: ourGames,
      scoreAgainst: oppGames,
      win: m.winnerId == null ? null : m.winnerId === usPid,
    });
    if (m.winnerId === usPid) wk.setsFor++;
    else if (m.winnerId != null) wk.setsAgainst++;
  }

  // Sets run seed 1 first (this team's player seed).
  for (const wk of byWeek.values()) wk.sets.sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
  return [...byWeek.values()].sort((a, b) => a.week - b.week);
}
