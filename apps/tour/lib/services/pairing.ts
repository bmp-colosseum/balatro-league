// Pairing service — the TO-driven ±2 negotiation console for one matchup. The pure
// engine (tour-core `pairing.ts`) does propose→respond, ±2 validation, and dead-end
// detection; this layer reconstructs the engine state from the matchup's persisted
// TourSets each request (no in-progress state model needed), runs one transition,
// and writes the resulting pair as a PROPOSED TourSet.
//
// One TO drives both sides, so a propose+respond is collapsed into a single
// transaction — but it still respects whoseProposeTurn + the ±2 window, so the live
// two-captain tool (auth + SSE, later) layers straight on top.
import { prisma } from "../db";
import {
  initPairing,
  propose,
  respond,
  whoseProposeTurn,
  isComplete,
  isDeadlocked,
  SEED_WINDOW,
  type RosterPlayer,
  type PairingState,
} from "@balatro/tour-core";

// Which roster week-block applies to a given week number. Roster blocks are
// "W1-4" / "W5-8" / … (4-week bands); subs create later blocks (B7). Falls back to
// the earliest block that exists for the team.
function weekBlockFor(weekNumber: number): string {
  const band = Math.floor((weekNumber - 1) / 4);
  return `W${band * 4 + 1}-${band * 4 + 4}`;
}

interface LoadedMatchup {
  matchup: {
    id: string;
    teamSeasonAId: string;
    teamSeasonBId: string;
    sendFirstTeamSeasonId: string | null;
    sets: { id: string; playerAId: string; playerBId: string; seedA: number; seedB: number; bestOf: number; status: string }[];
  };
  weekNumber: number;
  seasonId: string;
  seasonName: string;
  defaultBestOf: number;
  teamA: { id: string; name: string; roster: RosterPlayer[] };
  teamB: { id: string; name: string; roster: RosterPlayer[] };
  nameOf: Map<string, string>;
}

async function load(matchupId: string): Promise<LoadedMatchup | null> {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { week: { include: { season: true } }, sets: true },
  });
  if (!matchup) return null;

  const season = matchup.week.season;
  const block = weekBlockFor(matchup.week.number);

  const teamSeasons = await prisma.teamSeason.findMany({
    where: { id: { in: [matchup.teamSeasonAId, matchup.teamSeasonBId] } },
    include: { team: true, rosters: { include: { entries: true } } },
  });
  const tsById = new Map(teamSeasons.map((t) => [t.id, t]));

  const rosterFor = (teamSeasonId: string): RosterPlayer[] => {
    const ts = tsById.get(teamSeasonId);
    if (!ts || ts.rosters.length === 0) return [];
    const roster = ts.rosters.find((r) => r.weekBlock === block) ?? [...ts.rosters].sort((a, b) => a.weekBlock.localeCompare(b.weekBlock))[0]!;
    return roster.entries.map((e) => ({ playerId: e.playerId, seed: e.seed })).sort((a, b) => a.seed - b.seed);
  };

  const teamA = { id: matchup.teamSeasonAId, name: tsById.get(matchup.teamSeasonAId)?.team.name ?? "?", roster: rosterFor(matchup.teamSeasonAId) };
  const teamB = { id: matchup.teamSeasonBId, name: tsById.get(matchup.teamSeasonBId)?.team.name ?? "?", roster: rosterFor(matchup.teamSeasonBId) };

  const ids = [...new Set([...teamA.roster, ...teamB.roster].map((p) => p.playerId))];
  const players = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  return {
    matchup,
    weekNumber: matchup.week.number,
    seasonId: season.id,
    seasonName: season.name,
    defaultBestOf: season.defaultBestOf,
    teamA,
    teamB,
    nameOf,
  };
}

// Reconstruct the engine state from the matchup's persisted pairs (TourSets).
function stateFrom(m: LoadedMatchup): PairingState {
  const sendFirst: "A" | "B" = m.matchup.sendFirstTeamSeasonId === m.matchup.teamSeasonBId ? "B" : "A";
  const base = initPairing(m.teamA.roster, m.teamB.roster, sendFirst);
  return { ...base, pairs: m.matchup.sets.map((s) => ({ aPlayerId: s.playerAId, bPlayerId: s.playerBId })) };
}

export async function getPairingConsole(matchupId: string) {
  const m = await load(matchupId);
  if (!m) return null;
  const state = stateFrom(m);
  const paired = new Set(state.pairs.flatMap((p) => [p.aPlayerId, p.bPlayerId]));
  const complete = isComplete(state);
  const deadlocked = isDeadlocked(state);

  const decorate = (team: { id: string; name: string; roster: RosterPlayer[] }) => ({
    id: team.id,
    name: team.name,
    players: team.roster.map((p) => ({ playerId: p.playerId, name: m.nameOf.get(p.playerId) ?? p.playerId, seed: p.seed, paired: paired.has(p.playerId) })),
  });

  return {
    matchupId: m.matchup.id,
    seasonName: m.seasonName,
    weekNumber: m.weekNumber,
    teamA: decorate(m.teamA),
    teamB: decorate(m.teamB),
    sendFirst: state.sendFirst,
    proposerTeam: complete ? null : whoseProposeTurn(state),
    windowSize: SEED_WINDOW,
    complete,
    deadlocked,
    pairs: m.matchup.sets.map((s) => ({
      setId: s.id,
      aName: m.nameOf.get(s.playerAId) ?? s.playerAId,
      aSeed: s.seedA,
      bName: m.nameOf.get(s.playerBId) ?? s.playerBId,
      bSeed: s.seedB,
      bestOf: s.bestOf,
      status: s.status,
    })),
  };
}

// Persist a completed pair (proposing team's player + the responder), validated
// through the engine's propose→respond + ±2 window. Writes a PROPOSED TourSet.
export async function makePair(matchupId: string, proposerPlayerId: string, responderPlayerId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const state = stateFrom(m);
  if (isComplete(state)) throw new Error("All players are already paired.");

  const by = whoseProposeTurn(state);
  const proposed = propose(state, by, proposerPlayerId);
  if (!proposed.ok) throw new Error(proposed.reason);
  const answered = respond(proposed.state, responderPlayerId);
  if (!answered.ok) throw new Error(answered.reason);

  await persistPair(m, answered.pair.aPlayerId, answered.pair.bPlayerId);
  return { pairs: state.pairs.length + 1 };
}

// TO override (§6.2): when the remaining players can't complete under ±2, the TO
// pairs them manually — bypasses the window but still enforces availability.
export async function overridePair(matchupId: string, aPlayerId: string, bPlayerId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const paired = new Set(m.matchup.sets.flatMap((s) => [s.playerAId, s.playerBId]));
  if (paired.has(aPlayerId) || paired.has(bPlayerId)) throw new Error("One of those players is already paired.");
  if (!m.teamA.roster.some((p) => p.playerId === aPlayerId)) throw new Error("Player A is not on team A's roster.");
  if (!m.teamB.roster.some((p) => p.playerId === bPlayerId)) throw new Error("Player B is not on team B's roster.");
  await persistPair(m, aPlayerId, bPlayerId);
  return { ok: true };
}

async function persistPair(m: LoadedMatchup, aPlayerId: string, bPlayerId: string) {
  const seedA = m.teamA.roster.find((p) => p.playerId === aPlayerId)?.seed ?? 0;
  const seedB = m.teamB.roster.find((p) => p.playerId === bPlayerId)?.seed ?? 0;
  await prisma.tourSet.create({
    data: {
      matchupId: m.matchup.id,
      seasonId: m.seasonId,
      playerAId: aPlayerId,
      playerBId: bPlayerId,
      seedA,
      seedB,
      bestOf: m.defaultBestOf,
      status: "PROPOSED",
    },
  });
}

// Set the coinflip winner (who proposes first). Stored on the matchup.
export async function setSendFirst(matchupId: string, team: "A" | "B") {
  const m = await prisma.matchup.findUnique({ where: { id: matchupId }, select: { teamSeasonAId: true, teamSeasonBId: true } });
  if (!m) throw new Error("No such matchup.");
  await prisma.matchup.update({
    where: { id: matchupId },
    data: { sendFirstTeamSeasonId: team === "B" ? m.teamSeasonBId : m.teamSeasonAId },
  });
}

// Deleting a TourSet doesn't cascade its core Match (Match is referenced by plain
// id, no relation — the decoupling rule), so drop any linked Match too.
export async function removePair(setId: string) {
  const s = await prisma.tourSet.findUnique({ where: { id: setId }, select: { matchId: true } });
  await prisma.tourSet.delete({ where: { id: setId } });
  if (s?.matchId) await prisma.match.delete({ where: { id: s.matchId } });
}

export async function resetPairing(matchupId: string) {
  const sets = await prisma.tourSet.findMany({ where: { matchupId }, select: { matchId: true } });
  await prisma.tourSet.deleteMany({ where: { matchupId } });
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
}
