// Career / all-time player stats, derived from the imported sets + rosters +
// playoff finals. Everything is a reduction over TourSet→Match (+ RosterEntry for
// teams, PlayoffSeries finals for rings). Data is small — compute in memory.
import { prisma } from "./db";

export interface PlayerCareer {
  playerId: string;
  name: string;
  seasons: number;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  rings: number;
}

interface Acc {
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  seasons: Set<string>;
  rings: number;
}

function newAcc(): Acc {
  return { setW: 0, setL: 0, gameW: 0, gameL: 0, seasons: new Set(), rings: 0 };
}

// Tally a player's set + game record from one set, given the canonical Match.
function applySet(
  acc: Acc,
  playerId: string,
  match: { playerAId: string; gamesWonA: number; gamesWonB: number; winnerId: string | null },
  setPlayerAId: string,
  seasonId: string | null,
) {
  if (seasonId) acc.seasons.add(seasonId);
  const gFor = match.playerAId === setPlayerAId ? match.gamesWonA : match.gamesWonB;
  const gAgainst = match.playerAId === setPlayerAId ? match.gamesWonB : match.gamesWonA;
  // setPlayerAId is "the player on this set's A side". For the player we're
  // tallying, figure out which side they are by comparing playerId.
  const isSetA = playerId === setPlayerAId;
  acc.gameW += isSetA ? gFor : gAgainst;
  acc.gameL += isSetA ? gAgainst : gFor;
  if (match.winnerId === playerId) acc.setW++;
  else if (match.winnerId && match.winnerId !== playerId) acc.setL++;
}

async function ringHolders(): Promise<Map<string, number>> {
  const finals = await prisma.playoffSeries.findMany({
    where: { round: "FINAL", winnerTeamSeasonId: { not: null } },
    select: { winnerTeamSeasonId: true },
  });
  const champTs = finals.map((f) => f.winnerTeamSeasonId).filter((x): x is string => !!x);
  const rings = new Map<string, number>();
  if (champTs.length) {
    const rosters = await prisma.roster.findMany({
      where: { teamSeasonId: { in: champTs } },
      include: { entries: true },
    });
    for (const r of rosters) for (const e of r.entries) rings.set(e.playerId, (rings.get(e.playerId) ?? 0) + 1);
  }
  return rings;
}

export async function getAllTimePlayers(): Promise<PlayerCareer[]> {
  const [players, sets, matches, rings, rosterEntries] = await Promise.all([
    prisma.player.findMany({ select: { id: true, displayName: true } }),
    prisma.tourSet.findMany({ where: { bracket: "REGULAR" }, select: { playerAId: true, playerBId: true, matchId: true, seasonId: true } }),
    prisma.match.findMany({ select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    ringHolders(),
    // Roster membership = "seasons" truth: a drafted player who never finished a game is
    // still on a team that season. Including these makes them visible (to drop/sub them).
    prisma.rosterEntry.findMany({ select: { playerId: true, roster: { select: { teamSeason: { select: { seasonId: true } } } } } }),
  ]);
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const acc = new Map<string, Acc>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = newAcc();
      acc.set(id, a);
    }
    return a;
  };

  for (const ts of sets) {
    const m = ts.matchId ? matchById.get(ts.matchId) : undefined;
    if (!m) continue;
    applySet(get(ts.playerAId), ts.playerAId, m, ts.playerAId, ts.seasonId);
    applySet(get(ts.playerBId), ts.playerBId, m, ts.playerAId, ts.seasonId);
  }
  for (const e of rosterEntries) get(e.playerId).seasons.add(e.roster.teamSeason.seasonId);
  for (const [pid, n] of rings) get(pid).rings = n;

  const out: PlayerCareer[] = [];
  for (const [id, a] of acc) {
    out.push({
      playerId: id,
      name: nameById.get(id) ?? id,
      seasons: a.seasons.size,
      setW: a.setW,
      setL: a.setL,
      gameW: a.gameW,
      gameL: a.gameL,
      rings: a.rings,
    });
  }
  return out;
}

export interface PlayerSeasonLine {
  seasonName: string;
  teamName: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
}
export interface SeasonLeader {
  playerId: string;
  name: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
}

// Top players in one season by set win % (min sets). Empty for team-only seasons
// (no per-player sets, e.g. Team Tour 4).
export async function getSeasonLeaders(seasonName: string, limit = 10, minSets = 5): Promise<SeasonLeader[]> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return [];
  const sets = await prisma.tourSet.findMany({
    where: { seasonId: season.id, bracket: "REGULAR" }, // season leaders = regular season
    select: { playerAId: true, matchId: true },
  });
  if (sets.length === 0) return [];
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
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
    for (const pid of [m.playerAId, m.playerBId]) {
      const a = get(pid);
      const gFor = m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
      const gAg = m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
      a.gameW += gFor;
      a.gameL += gAg;
      if (m.winnerId === pid) a.setW++;
      else if (m.winnerId) a.setL++;
    }
  }

  const players = await prisma.player.findMany({ where: { id: { in: [...acc.keys()] } }, select: { id: true, displayName: true } });
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);
  return [...acc.entries()]
    .filter(([, a]) => a.setW + a.setL >= minSets)
    .map(([id, a]) => ({ playerId: id, name: nameById.get(id) ?? id, ...a }))
    .sort((x, y) => rate(y.setW, y.setL) - rate(x.setW, x.setL) || y.setW - x.setW)
    .slice(0, limit);
}

export interface H2HLine {
  opponentId: string;
  name: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
}
export interface PlayerDetail extends PlayerCareer {
  discordId: string; // "legacy:<slug>" until mapped to a real Discord id
  playoff: { setW: number; setL: number; gameW: number; gameL: number }; // post-season record (regular is the default)
  perSeason: PlayerSeasonLine[];
  h2h: H2HLine[];
}

// Resolve a player by their Discord id — the cross-site join key (used by the
// /u/[discordId] resolver so the league can deep-link to a Tour profile).
export function playerIdByDiscord(discordId: string) {
  return prisma.player.findUnique({ where: { discordId }, select: { id: true } });
}

// Imported career counters (avg seed, championships/finals/playoffs made, captain).
// null for players not in the Player Stats sheet.
export function getPlayerCareerStat(playerId: string) {
  return prisma.playerCareerStat.findUnique({ where: { playerId } });
}

export async function getPlayer(playerId: string): Promise<PlayerDetail | null> {
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true, displayName: true, discordId: true } });
  if (!player) return null;

  const [seasons, entries, sets, matches, rings, allPlayers] = await Promise.all([
    prisma.tourSeason.findMany({ select: { id: true, name: true } }),
    prisma.rosterEntry.findMany({
      where: { playerId },
      include: { roster: { include: { teamSeason: { include: { team: true, season: true } } } } },
    }),
    prisma.tourSet.findMany({
      where: { OR: [{ playerAId: playerId }, { playerBId: playerId }] },
      select: { playerAId: true, playerBId: true, matchId: true, seasonId: true, bracket: true },
    }),
    prisma.match.findMany({ select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    ringHolders(),
    prisma.player.findMany({ select: { id: true, displayName: true } }),
  ]);
  const nameOf = new Map(allPlayers.map((p) => [p.id, p.displayName]));
  const seasonName = new Map(seasons.map((s) => [s.id, s.name]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const teamForSeason = new Map<string, string>();
  for (const e of entries) teamForSeason.set(e.roster.teamSeason.season.id, e.roster.teamSeason.team.name);

  const career = newAcc();
  const playoff = newAcc(); // regular season is the default record; playoffs tracked apart
  const bySeason = new Map<string, Acc>();
  const getS = (sid: string) => {
    let a = bySeason.get(sid);
    if (!a) {
      a = newAcc();
      bySeason.set(sid, a);
    }
    return a;
  };
  const h2hAcc = new Map<string, { setW: number; setL: number; gameW: number; gameL: number }>();
  for (const ts of sets) {
    const m = ts.matchId ? matchById.get(ts.matchId) : undefined;
    if (!m) continue;
    if (ts.bracket === "PLAYOFF") { applySet(playoff, playerId, m, ts.playerAId, ts.seasonId); continue; }
    applySet(career, playerId, m, ts.playerAId, ts.seasonId);
    if (ts.seasonId) applySet(getS(ts.seasonId), playerId, m, ts.playerAId, ts.seasonId);
    const oppId = ts.playerAId === playerId ? ts.playerBId : ts.playerAId;
    let h = h2hAcc.get(oppId);
    if (!h) {
      h = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      h2hAcc.set(oppId, h);
    }
    // Per-opponent game tally, same orientation logic as applySet.
    const gFor = m.playerAId === ts.playerAId ? m.gamesWonA : m.gamesWonB;
    const gAgainst = m.playerAId === ts.playerAId ? m.gamesWonB : m.gamesWonA;
    const isSetA = playerId === ts.playerAId;
    h.gameW += isSetA ? gFor : gAgainst;
    h.gameL += isSetA ? gAgainst : gFor;
    if (m.winnerId === playerId) h.setW++;
    else if (m.winnerId) h.setL++;
  }
  // Full opponent list; the client table re-sorts. Default: most sets played.
  const h2h: H2HLine[] = [...h2hAcc.entries()]
    .map(([opponentId, r]) => ({ opponentId, name: nameOf.get(opponentId) ?? opponentId, ...r }))
    .sort((a, b) => b.setW + b.setL - (a.setW + a.setL));

  const perSeason: PlayerSeasonLine[] = [...bySeason.entries()]
    .map(([sid, a]) => ({
      seasonName: seasonName.get(sid) ?? sid,
      teamName: teamForSeason.get(sid) ?? "—",
      setW: a.setW,
      setL: a.setL,
      gameW: a.gameW,
      gameL: a.gameL,
    }))
    .sort((x, y) => x.seasonName.localeCompare(y.seasonName));

  return {
    playerId: player.id,
    discordId: player.discordId,
    name: player.displayName,
    seasons: career.seasons.size,
    setW: career.setW,
    setL: career.setL,
    gameW: career.gameW,
    gameL: career.gameL,
    rings: rings.get(playerId) ?? 0,
    playoff: { setW: playoff.setW, setL: playoff.setL, gameW: playoff.gameW, gameL: playoff.gameL },
    perSeason,
    h2h,
  };
}
