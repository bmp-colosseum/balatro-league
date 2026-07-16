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
import { notifyLive } from "../notify";
import { enqueuePairingTurn } from "../queue";
import {
  initPairing,
  propose,
  respond,
  whoseProposeTurn,
  eligibleResponses,
  isComplete,
  isDeadlocked,
  SEED_WINDOW,
  type RosterPlayer,
  type PairingState,
} from "@balatro/tour-core";
import { rosterForWeek, ensureMembership, captainAtWeek, subOnlyKeySet } from "./roster-ops";

// Never print a raw cuid when a Player row can't be resolved (deleted/merged players
// can leave dangling roster references) -- a labeled stub keeps the UI readable.
const unresolved = (id: string) => `(unlinked ${id.slice(-6)})`;

interface LoadedMatchup {
  matchup: {
    id: string;
    teamSeasonAId: string;
    teamSeasonBId: string;
    sendFirstTeamSeasonId: string | null;
    pendingProposalPlayerId: string | null;
    sets: { id: string; playerAId: string; playerBId: string; seedA: number; seedB: number; bestOf: number; status: string }[];
  };
  weekNumber: number;
  weekKind: string; // WeekKind -- "PLAYOFF" sets get team-stamped + bracket-tagged
  deadlineAt: Date | null; // soft weekly target (may be null)
  seasonId: string;
  seasonName: string;
  defaultBestOf: number;
  teamSize: number; // sets per matchup -- the pairing TARGET (rosters may hold more/fewer)
  teamA: { id: string; name: string; roster: RosterPlayer[]; captainId: string };
  teamB: { id: string; name: string; roster: RosterPlayer[]; captainId: string };
  nameOf: Map<string, string>;
  subOnly: Set<string>; // `${teamSeasonId}|${playerId}` -- sub stints only, no seed held
}

async function load(matchupId: string): Promise<LoadedMatchup | null> {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    // Sets in team-A seed order: the console reads top-down as A's #1, #2, ... with
    // whoever each is paired against on the right.
    include: { week: { include: { season: true } }, sets: { orderBy: { seedA: "asc" } } },
  });
  if (!matchup) return null;

  const season = matchup.week.season;

  const teamSeasons = await prisma.teamSeason.findMany({
    where: { id: { in: [matchup.teamSeasonAId, matchup.teamSeasonBId] } },
    include: { team: true },
  });
  const tsById = new Map(teamSeasons.map((t) => [t.id, t]));

  // The lineup is DERIVED for this matchup's week from the roster-move log, so subs
  // / departures that apply to this week are reflected in who can be paired. The
  // captain is also week-derived (succession via the move log).
  const [lineA, lineB, movesA, movesB] = await Promise.all([
    rosterForWeek(matchup.teamSeasonAId, matchup.week.number),
    rosterForWeek(matchup.teamSeasonBId, matchup.week.number),
    prisma.rosterMove.findMany({ where: { teamSeasonId: matchup.teamSeasonAId }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] }),
    prisma.rosterMove.findMany({ where: { teamSeasonId: matchup.teamSeasonBId }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] }),
  ]);
  const toRoster = (line: { playerId: string; seed: number }[]): RosterPlayer[] => line.map((p) => ({ playerId: p.playerId, seed: p.seed }));
  const capA = captainAtWeek(movesA, matchup.week.number, tsById.get(matchup.teamSeasonAId)?.captainPlayerId ?? "");
  const capB = captainAtWeek(movesB, matchup.week.number, tsById.get(matchup.teamSeasonBId)?.captainPlayerId ?? "");

  const teamA = { id: matchup.teamSeasonAId, name: tsById.get(matchup.teamSeasonAId)?.team.name ?? "?", roster: toRoster(lineA), captainId: capA };
  const teamB = { id: matchup.teamSeasonBId, name: tsById.get(matchup.teamSeasonBId)?.team.name ?? "?", roster: toRoster(lineB), captainId: capB };

  // Resolve names for everyone the console can mention: this week's lineups PLUS every
  // player the sets reference (subs whose window is elsewhere, players since subbed out,
  // reassigned originals) and both captains -- otherwise those render as raw player ids.
  const ids = [
    ...new Set([
      ...[...teamA.roster, ...teamB.roster].map((p) => p.playerId),
      ...matchup.sets.flatMap((s) => [s.playerAId, s.playerBId]),
      capA,
      capB,
    ]),
  ].filter(Boolean);
  const [players, subOnly] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    subOnlyKeySet([matchup.teamSeasonAId, matchup.teamSeasonBId]),
  ]);
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  return {
    matchup,
    weekNumber: matchup.week.number,
    weekKind: matchup.week.kind,
    deadlineAt: matchup.week.deadlineAt,
    seasonId: season.id,
    seasonName: season.name,
    defaultBestOf: season.defaultBestOf,
    teamSize: season.teamSize,
    teamA,
    teamB,
    nameOf,
    subOnly,
  };
}

// Reconstruct the engine state from the matchup's persisted pairs (TourSets) + any
// in-flight proposal (the live two-captain flow persists it on the Matchup).
function stateFrom(m: LoadedMatchup): PairingState {
  const sendFirst: "A" | "B" = m.matchup.sendFirstTeamSeasonId === m.matchup.teamSeasonBId ? "B" : "A";
  const base = initPairing(m.teamA.roster, m.teamB.roster, sendFirst);
  const state: PairingState = { ...base, pairs: m.matchup.sets.map((s) => ({ aPlayerId: s.playerAId, bPlayerId: s.playerBId })) };
  const pendId = m.matchup.pendingProposalPlayerId;
  if (pendId) {
    const inA = m.teamA.roster.find((p) => p.playerId === pendId);
    const inB = m.teamB.roster.find((p) => p.playerId === pendId);
    if (inA) state.pending = { by: "A", playerId: pendId, seed: inA.seed };
    else if (inB) state.pending = { by: "B", playerId: pendId, seed: inB.seed };
  }
  return state;
}

export async function getPairingConsole(matchupId: string) {
  const m = await load(matchupId);
  if (!m) return null;
  const state = stateFrom(m);
  const paired = new Set(state.pairs.flatMap((p) => [p.aPlayerId, p.bPlayerId]));
  // Target = the season's sets-per-matchup, bounded by what the rosters can field --
  // unequal rosters or benched subs never make a matchup "unfinishable".
  const complete = isComplete(state, m.teamSize);
  const deadlocked = isDeadlocked(state, m.teamSize);
  const targetPairs = Math.min(m.teamSize, m.teamA.roster.length, m.teamB.roster.length);

  const decorate = (team: { id: string; name: string; roster: RosterPlayer[] }) => ({
    id: team.id,
    name: team.name,
    players: team.roster.map((p) => ({ playerId: p.playerId, name: m.nameOf.get(p.playerId) ?? unresolved(p.playerId), seed: p.seed, paired: paired.has(p.playerId) })),
  });

  return {
    matchupId: m.matchup.id,
    seasonName: m.seasonName,
    weekNumber: m.weekNumber,
    weekKind: m.weekKind, // "PLAYOFF" etc. -- lets the console default its back link sensibly
    deadlineAt: m.deadlineAt,
    teamA: decorate(m.teamA),
    teamB: decorate(m.teamB),
    sendFirst: state.sendFirst,
    proposerTeam: complete ? null : whoseProposeTurn(state),
    windowSize: SEED_WINDOW,
    complete,
    deadlocked,
    targetPairs,
    pairs: m.matchup.sets.map((s) => ({
      setId: s.id,
      aName: m.nameOf.get(s.playerAId) ?? unresolved(s.playerAId),
      aPlayerId: s.playerAId,
      aSeed: s.seedA,
      aIsSub: m.subOnly.has(`${m.teamA.id}|${s.playerAId}`),
      bName: m.nameOf.get(s.playerBId) ?? unresolved(s.playerBId),
      bPlayerId: s.playerBId,
      bSeed: s.seedB,
      bIsSub: m.subOnly.has(`${m.teamB.id}|${s.playerBId}`),
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

// Bulk seed-for-seed pairing -- the one-click playoff default. Sorts each team's roster by
// seed (best first) and pairs same-rank players (A's #1 vs B's #1, and so on). Only fills in
// still-unpaired players up to the matchup's target, so it never disturbs existing pairs or
// recorded results -- run it on a fresh matchup to set everything at once, or to top up.
export async function autoPairSeedForSeed(matchupId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const paired = new Set(m.matchup.sets.flatMap((s) => [s.playerAId, s.playerBId]));
  const bySeed = (r: RosterPlayer[]) => [...r].sort((a, b) => a.seed - b.seed);
  const unpairedA = bySeed(m.teamA.roster).filter((p) => !paired.has(p.playerId));
  const unpairedB = bySeed(m.teamB.roster).filter((p) => !paired.has(p.playerId));
  const targetPairs = Math.min(m.teamSize, m.teamA.roster.length, m.teamB.roster.length);
  const remaining = Math.max(0, targetPairs - m.matchup.sets.length);
  const n = Math.min(unpairedA.length, unpairedB.length, remaining);
  if (n === 0) throw new Error("Nothing to pair -- everyone's already paired (reset first to re-pair).");
  for (let i = 0; i < n; i++) await persistPair(m, unpairedA[i].playerId, unpairedB[i].playerId);
  return { created: n };
}

async function persistPair(m: LoadedMatchup, aPlayerId: string, bPlayerId: string) {
  const seedA = m.teamA.roster.find((p) => p.playerId === aPlayerId)?.seed ?? 0;
  const seedB = m.teamB.roster.find((p) => p.playerId === bPlayerId)?.seed ?? 0;
  // Playoff sets carry their team + week + bracket tag directly (not reconstructed from
  // rosters) so a cross-team sub is attributed to the team they played FOR, and the
  // public bracket / playoff reads can find them. Regular sets are left as-is.
  const isPlayoff = m.weekKind === "PLAYOFF";
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
      ...(isPlayoff
        ? { teamSeasonAId: m.matchup.teamSeasonAId, teamSeasonBId: m.matchup.teamSeasonBId, bracket: "PLAYOFF", week: m.weekNumber }
        : {}),
    },
  });
  await notifyLive(`matchup:${m.matchup.id}`); // live refresh (C5)
}

// Set the coinflip winner (who proposes first). Stored on the matchup.
export async function setSendFirst(matchupId: string, team: "A" | "B") {
  const m = await prisma.matchup.findUnique({ where: { id: matchupId }, select: { teamSeasonAId: true, teamSeasonBId: true } });
  if (!m) throw new Error("No such matchup.");
  await prisma.matchup.update({
    where: { id: matchupId },
    data: { sendFirstTeamSeasonId: team === "B" ? m.teamSeasonBId : m.teamSeasonAId },
  });
  await notifyLive(`matchup:${matchupId}`);
}

// Change a set's best-of directly (players may agree higher/lower; or fix a set
// created under the wrong season default). Works on played sets too -- the games
// already recorded stand; only the format label (and future forfeit math) changes.
export async function setSetBestOf(setId: string, bestOf: number) {
  const n = Math.trunc(bestOf);
  if (!Number.isFinite(n) || n < 1 || n > 15) throw new Error("Best-of must be between 1 and 15.");
  if (n % 2 === 0) throw new Error("Best-of must be odd (Bo1/Bo3/Bo5...).");
  const set = await prisma.tourSet.findUnique({ where: { id: setId }, select: { matchId: true, matchupId: true } });
  if (!set) throw new Error("No such set.");
  await prisma.tourSet.update({ where: { id: setId }, data: { bestOf: n } });
  // Keep the linked Match's format label in step (it was stamped "BO<n>" at report time).
  if (set.matchId) await prisma.match.update({ where: { id: set.matchId }, data: { format: `BO${n}` } });
  if (set.matchupId) await notifyLive(`matchup:${set.matchupId}`);
  return { bestOf: n };
}

// Deleting a TourSet doesn't cascade its core Match (Match is referenced by plain
// id, no relation — the decoupling rule), so drop any linked Match too.
export async function removePair(setId: string) {
  const s = await prisma.tourSet.findUnique({ where: { id: setId }, select: { matchId: true, matchupId: true } });
  await prisma.tourSet.delete({ where: { id: setId } });
  if (s?.matchId) await prisma.match.delete({ where: { id: s.matchId } });
  if (s?.matchupId) await notifyLive(`matchup:${s.matchupId}`);
}

export async function resetPairing(matchupId: string) {
  const sets = await prisma.tourSet.findMany({ where: { matchupId }, select: { matchId: true } });
  await prisma.tourSet.deleteMany({ where: { matchupId } });
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  await notifyLive(`matchup:${matchupId}`);
}

// Reassign the player on ONE side of an UNPLAYED set to a substitute — for a late
// "makeup" set the originally-paired player can no longer play (e.g. they dropped
// out). The set keeps its identity (matchup, week, opponent); only who plays it
// changes. TO authority: bypasses the ±2 / week-lineup checks (the sub may have
// joined after the set's week). playerAId/B = who actually plays (so stats credit
// the sub); the original is remembered in reassignedFromId for the audit.
export async function reassignSetPlayer(setId: string, side: "A" | "B", inPlayerId: string, _reason?: string) {
  if (!inPlayerId) throw new Error("Pick the substitute.");
  const set = await prisma.tourSet.findUnique({
    where: { id: setId },
    include: { matchup: { include: { week: { include: { season: { select: { id: true } } } } } } },
  });
  if (!set || !set.matchup) throw new Error("No such set.");
  if (set.status === "CONFIRMED" || set.status === "REPORTED" || set.status === "FORFEIT") {
    throw new Error("This set is already played — clear its result first, then reassign.");
  }
  const teamSeasonId = side === "A" ? set.matchup.teamSeasonAId : set.matchup.teamSeasonBId;
  const currentId = side === "A" ? set.playerAId : set.playerBId;
  const otherId = side === "A" ? set.playerBId : set.playerAId;
  if (inPlayerId === currentId) throw new Error("That player already has this set.");
  if (inPlayerId === otherId) throw new Error("Can't pair a player against themselves.");

  // The sub must attribute to this team — make sure they're a season member.
  const seed = side === "A" ? set.seedA : set.seedB;
  await ensureMembership(teamSeasonId, inPlayerId, seed);

  await prisma.tourSet.update({
    where: { id: setId },
    data: {
      ...(side === "A" ? { playerAId: inPlayerId } : { playerBId: inPlayerId }),
      reassignedFromId: set.reassignedFromId ?? currentId, // keep the FIRST original
    },
  });
  return { ok: true };
}

// ── Live two-captain pairing ────────────────────────────────────────────────
// Each captain acts only for their own team; turn order + the ±2 window are
// enforced by the engine. A proposal persists on the Matchup until the other
// captain responds (→ pair) — so the two halves can happen at different times.

// Which side this viewer captains in this matchup (or null if not a captain here).
function captainSide(m: LoadedMatchup, viewerPlayerId: string): "A" | "B" | null {
  if (viewerPlayerId && m.teamA.captainId === viewerPlayerId) return "A";
  if (viewerPlayerId && m.teamB.captainId === viewerPlayerId) return "B";
  return null;
}

// The captain's view of one matchup: the board, whose turn it is, what THIS captain
// can do right now (propose / respond / wait), and the eligible options.
export async function getCaptainPairing(matchupId: string, viewerPlayerId: string) {
  const m = await load(matchupId);
  if (!m) return null;
  const side = captainSide(m, viewerPlayerId);
  if (!side) return { authorized: false as const, seasonName: m.seasonName };

  const state = stateFrom(m);
  const paired = new Set(state.pairs.flatMap((p) => [p.aPlayerId, p.bPlayerId]));
  const complete = isComplete(state, m.teamSize);
  const deadlocked = isDeadlocked(state, m.teamSize);
  const myTeam = side === "A" ? m.teamA : m.teamB;
  const oppTeam = side === "A" ? m.teamB : m.teamA;

  const pend = state.pending ?? null;
  const myTurnToPropose = !pend && !complete && whoseProposeTurn(state) === side;
  const myTurnToRespond = !!pend && pend.by !== side;
  const waitingOnOpp = (!!pend && pend.by === side) || (!pend && !complete && whoseProposeTurn(state) !== side);

  const avail = (team: { roster: RosterPlayer[] }) =>
    team.roster.filter((p) => !paired.has(p.playerId) && p.playerId !== pend?.playerId).map((p) => ({ playerId: p.playerId, name: m.nameOf.get(p.playerId) ?? unresolved(p.playerId), seed: p.seed }));

  const decorate = (team: typeof m.teamA) => ({
    name: team.name,
    captainName: m.nameOf.get(team.captainId) ?? "—",
    captainId: team.captainId,
    players: team.roster.map((p) => ({ playerId: p.playerId, name: m.nameOf.get(p.playerId) ?? unresolved(p.playerId), seed: p.seed, paired: paired.has(p.playerId), pending: p.playerId === pend?.playerId })),
  });

  return {
    authorized: true as const,
    matchupId,
    seasonName: m.seasonName,
    weekNumber: m.weekNumber,
    deadlineAt: m.deadlineAt,
    side,
    myTeamName: myTeam.name,
    oppTeamName: oppTeam.name,
    teamA: decorate(m.teamA),
    teamB: decorate(m.teamB),
    windowSize: SEED_WINDOW,
    complete,
    deadlocked,
    pending: pend ? { byMe: pend.by === side, playerName: m.nameOf.get(pend.playerId) ?? unresolved(pend.playerId), seed: pend.seed } : null,
    myTurnToPropose,
    myTurnToRespond,
    waitingOnOpp,
    proposeOptions: myTurnToPropose ? avail(myTeam) : [],
    respondOptions: myTurnToRespond ? eligibleResponses(state).map((p) => ({ playerId: p.playerId, name: m.nameOf.get(p.playerId) ?? unresolved(p.playerId), seed: p.seed })) : [],
    pairs: m.matchup.sets.map((s) => ({
      aName: m.nameOf.get(s.playerAId) ?? unresolved(s.playerAId),
      aPlayerId: s.playerAId,
      aSeed: s.seedA,
      aIsSub: m.subOnly.has(`${m.teamA.id}|${s.playerAId}`),
      bName: m.nameOf.get(s.playerBId) ?? unresolved(s.playerBId),
      bPlayerId: s.playerBId,
      bSeed: s.seedB,
      bIsSub: m.subOnly.has(`${m.teamB.id}|${s.playerBId}`),
      status: s.status,
    })),
  };
}

// A captain proposes a player from their team (when it's their turn). Persists the
// proposal on the Matchup; the opposing captain responds next.
// DM the captain whose move it now is (C3). Fire-and-forget; legacy ids skipped.
async function pingCaptainTurn(m: LoadedMatchup, side: "A" | "B", kind: "respond" | "propose") {
  try {
    const team = side === "A" ? m.teamA : m.teamB;
    const opp = side === "A" ? m.teamB : m.teamA;
    const cap = await prisma.player.findUnique({ where: { id: team.captainId }, select: { discordId: true } });
    if (!cap || !/^\d+$/.test(cap.discordId)) return;
    await enqueuePairingTurn({
      discordId: cap.discordId,
      kind,
      weekNumber: m.weekNumber,
      myTeamName: team.name,
      oppTeamName: opp.name,
      urlPath: `/matchups/${m.matchup.id}`,
    });
  } catch {
    /* pings are best-effort */
  }
}

export async function captainPropose(matchupId: string, viewerPlayerId: string, playerId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const side = captainSide(m, viewerPlayerId);
  if (!side) throw new Error("You're not a captain in this matchup.");
  const state = stateFrom(m);
  const r = propose(state, side, playerId);
  if (!r.ok) throw new Error(r.reason);
  await prisma.matchup.update({ where: { id: matchupId }, data: { pendingProposalPlayerId: playerId } });
  await notifyLive(`matchup:${matchupId}`);
  await pingCaptainTurn(m, side === "A" ? "B" : "A", "respond"); // the opposing captain answers
  return { ok: true };
}

// The opposing captain responds with a player within ±2 → persists the pair and
// clears the proposal.
export async function captainRespond(matchupId: string, viewerPlayerId: string, playerId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const side = captainSide(m, viewerPlayerId);
  if (!side) throw new Error("You're not a captain in this matchup.");
  const state = stateFrom(m);
  if (!state.pending) throw new Error("There's no proposal to respond to.");
  if (state.pending.by === side) throw new Error("You proposed — the other captain responds.");
  const r = respond(state, playerId);
  if (!r.ok) throw new Error(r.reason);
  await persistPair(m, r.pair.aPlayerId, r.pair.bPlayerId);
  await prisma.matchup.update({ where: { id: matchupId }, data: { pendingProposalPlayerId: null } });
  await notifyLive(`matchup:${matchupId}`);
  // If pairing isn't finished, ping whoever proposes next.
  const m2 = await load(matchupId);
  if (m2) {
    const s2 = stateFrom(m2);
    if (!isComplete(s2)) await pingCaptainTurn(m2, whoseProposeTurn(s2), "propose");
  }
  return { ok: true };
}

// A captain retracts their own pending proposal (before it's answered).
export async function captainCancelProposal(matchupId: string, viewerPlayerId: string) {
  const m = await load(matchupId);
  if (!m) throw new Error("No such matchup.");
  const side = captainSide(m, viewerPlayerId);
  if (!side) throw new Error("You're not a captain in this matchup.");
  const state = stateFrom(m);
  if (!state.pending || state.pending.by !== side) throw new Error("You have no pending proposal to cancel.");
  await prisma.matchup.update({ where: { id: matchupId }, data: { pendingProposalPlayerId: null } });
  await notifyLive(`matchup:${matchupId}`);
  return { ok: true };
}

// The captain's matchups in a season (for the /me 'pair this week' list).
export async function getCaptainMatchups(seasonName: string, viewerPlayerId: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season || !viewerPlayerId) return [];
  // Teams this player currently captains.
  const teams = await prisma.teamSeason.findMany({ where: { seasonId: season.id, captainPlayerId: viewerPlayerId }, select: { id: true } });
  const teamIds = new Set(teams.map((t) => t.id));
  if (teamIds.size === 0) return [];

  const matchups = await prisma.matchup.findMany({
    where: { week: { seasonId: season.id }, OR: [{ teamSeasonAId: { in: [...teamIds] } }, { teamSeasonBId: { in: [...teamIds] } }] },
    include: { week: { select: { number: true, deadlineAt: true } } },
  });
  const tsIds = [...new Set(matchups.flatMap((mu) => [mu.teamSeasonAId, mu.teamSeasonBId]))];
  const ts = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const nameOf = new Map(ts.map((t) => [t.id, t.team.name]));

  return matchups
    .map((mu) => {
      const mine = teamIds.has(mu.teamSeasonAId) ? "A" : "B";
      const oppId = mine === "A" ? mu.teamSeasonBId : mu.teamSeasonAId;
      const setCount = mu.setsWonA != null ? "done" : mu.pendingProposalPlayerId ? "proposal pending" : "to pair";
      return { matchupId: mu.id, week: mu.week.number, deadline: mu.week.deadlineAt, opponent: nameOf.get(oppId) ?? "?", oppTeamSeasonId: oppId, status: setCount, decided: mu.setsWonA != null };
    })
    .sort((a, b) => a.week - b.week);
}

// Substitute options for a matchup's two teams — each team's full season membership
// plus the free-agent pool — for the reassign control (broader than the week lineup,
// since a sub may have joined later).
export async function getMatchupSubOptions(matchupId: string) {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { week: { select: { seasonId: true } } },
  });
  if (!matchup) return null;
  const seasonId = matchup.week.seasonId;

  const [teamSeasons, approved] = await Promise.all([
    prisma.teamSeason.findMany({ where: { seasonId }, include: { rosters: { include: { entries: true } } } }),
    prisma.signup.findMany({ where: { seasonId, status: "APPROVED" }, select: { discordId: true } }),
  ]);
  const memberOf = (tsId: string) => {
    const ts = teamSeasons.find((t) => t.id === tsId);
    return ts ? [...new Set(ts.rosters.flatMap((r) => r.entries.map((e) => e.playerId)))] : [];
  };
  const rosteredAll = new Set(teamSeasons.flatMap((t) => t.rosters.flatMap((r) => r.entries.map((e) => e.playerId))));
  const fa = await prisma.player.findMany({ where: { discordId: { in: approved.map((a) => a.discordId) } }, select: { id: true, displayName: true } });
  const freeAgentIds = fa.filter((p) => !rosteredAll.has(p.id)).map((p) => p.id);

  const ids = [...new Set([...memberOf(matchup.teamSeasonAId), ...memberOf(matchup.teamSeasonBId), ...freeAgentIds])];
  const players = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const opt = (pid: string) => ({ id: pid, name: nameOf.get(pid) ?? unresolved(pid) });

  return {
    subsA: [...memberOf(matchup.teamSeasonAId), ...freeAgentIds].map(opt),
    subsB: [...memberOf(matchup.teamSeasonBId), ...freeAgentIds].map(opt),
  };
}
