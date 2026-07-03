// Fantasy service (ws08) — the shell around the pure scoring core (@balatro/tour-core
// fantasy). Managers draft real players; standings DERIVE on read from the season's sets,
// so a corrected result reflows automatically. Auth-agnostic (callers gate); the sim and
// the (future) UI/bot are thin callers of these functions.
import { prisma } from "../db";
import { snakeOrder, tallyFantasyBySlot, type SlottedSet } from "@balatro/tour-core";

async function seasonByName(name: string) {
  const s = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true, teamSize: true } });
  if (!s) throw new Error(`No season "${name}"`);
  return s;
}

// The draftable player pool = every player on a real roster this season, with the team +
// intra-team seed they were drafted at. Sourced from DraftPick (captains self-pick, so it
// covers whole rosters). Ordered by overall pick so a fantasy auto-draft is deterministic.
export async function getFantasyPool(seasonName: string) {
  const season = await seasonByName(seasonName);
  const draft = await prisma.draft.findUnique({ where: { seasonId: season.id }, select: { id: true } });
  if (!draft) throw new Error("No draft yet — the player pool is set by the real draft.");
  const picks = await prisma.draftPick.findMany({
    where: { draftId: draft.id, playerId: { not: null } },
    orderBy: { pickIndex: "asc" },
    select: { playerId: true, teamSeasonId: true, round: true },
  });
  const players = await prisma.player.findMany({
    where: { id: { in: picks.map((p) => p.playerId!) } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  return picks.map((p) => ({
    playerId: p.playerId!,
    name: nameOf.get(p.playerId!) ?? p.playerId!,
    teamSeasonId: p.teamSeasonId,
    seed: p.round, // intra-team seed = draft round
  }));
}

export interface OpenFantasyInput {
  scope?: "SEASON" | "PLAYOFFS";
  rosterSize?: number; // defaults to the real teamSize
  setWinPoints?: number;
  gameWinPoints?: number;
  tradesEnabled?: boolean;
}

export async function openFantasyLeague(seasonName: string, input: OpenFantasyInput = {}) {
  const season = await seasonByName(seasonName);
  const existing = await prisma.fantasyLeague.findUnique({ where: { seasonId: season.id } });
  if (existing) throw new Error("A fantasy league already exists for this season.");
  return prisma.fantasyLeague.create({
    data: {
      seasonId: season.id,
      scope: input.scope === "PLAYOFFS" ? "PLAYOFFS" : "SEASON",
      rosterSize: Number(input.rosterSize) || season.teamSize,
      setWinPoints: input.setWinPoints ?? 1,
      gameWinPoints: input.gameWinPoints ?? 1,
      tradesEnabled: input.tradesEnabled ?? true,
    },
  });
}

export async function getFantasyLeague(seasonName: string) {
  const season = await seasonByName(seasonName);
  return prisma.fantasyLeague.findUnique({ where: { seasonId: season.id }, include: { teams: { include: { picks: true } } } });
}

// Snake auto-draft: assign the pool to `managers` in serpentine order until each has a full
// roster. Unique ownership; max managers is bounded so the pool divides evenly (rosterSize x
// managers <= pool). Used by the sim and as the "autopick" fallback for the real draft.
export async function autoDraftFantasy(seasonName: string, managers: { discordId: string; name: string }[]) {
  const league = await getFantasyLeague(seasonName);
  if (!league) throw new Error("Open a fantasy league first.");
  if (league.teams.length) throw new Error("This fantasy league has already drafted.");
  const pool = await getFantasyPool(seasonName);
  const maxManagers = Math.floor(pool.length / league.rosterSize);
  if (managers.length < 2) throw new Error("Need at least 2 fantasy managers.");
  if (managers.length > maxManagers) throw new Error(`At most ${maxManagers} managers (pool of ${pool.length} ÷ roster ${league.rosterSize}).`);

  const teams = await Promise.all(
    managers.map((m) => prisma.fantasyTeam.create({ data: { leagueId: league.id, managerDiscordId: m.discordId, name: m.name } })),
  );
  // Serpentine order over teams for rosterSize rounds → overall pick sequence.
  const order = snakeOrder(teams.map((t) => t.id), league.rosterSize);
  await prisma.fantasyPick.createMany({
    data: order.map((fantasyTeamId, pickIndex) => {
      const p = pool[pickIndex];
      return { fantasyTeamId, pickIndex, playerId: p.playerId, teamSeasonId: p.teamSeasonId, seed: p.seed };
    }),
  });
  return { league: league.id, managers: teams.length, picks: order.length };
}

// Cumulative standings — derive on read. Loads the in-scope decided sets, maps each set's
// real players to their fantasy owner, and tallies via the pure core. SEASON = every set;
// PLAYOFFS = only playoff-week sets (eliminated players simply have no more sets).
export async function getFantasyStandings(seasonName: string) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    include: { teams: { include: { picks: { select: { playerId: true, teamSeasonId: true, seed: true } } } } },
  });
  if (!league) return null;

  // Two lookups for the slot-aware tally: by drafted player (identity, re-seed-safe) and by
  // the drafted seed slot (so a sub/replacement's points flow to that slot's owner).
  const ownerByPlayer = new Map<string, string>();
  const ownerBySlot = new Map<string, string>(); // key `${teamSeasonId}:${seed}`
  for (const t of league.teams) {
    for (const pk of t.picks) {
      ownerByPlayer.set(pk.playerId, t.name);
      ownerBySlot.set(`${pk.teamSeasonId}:${pk.seed}`, t.name);
    }
  }

  // In-scope decided sets (have a linked core Match). Playoff scope filters by week kind.
  const sets = await prisma.tourSet.findMany({
    where: {
      matchId: { not: null },
      OR: [{ seasonId: season.id }, { matchup: { week: { seasonId: season.id } } }],
      ...(league.scope === "PLAYOFFS" ? { matchup: { week: { kind: "PLAYOFF" } } } : {}),
    },
    select: {
      playerAId: true, playerBId: true, seedA: true, seedB: true,
      teamSeasonAId: true, teamSeasonBId: true, matchId: true,
      // Live sets carry their team link on the matchup (the set's own columns are for
      // historical imports); set side A == matchup team A (schema §TourSet).
      matchup: { select: { teamSeasonAId: true, teamSeasonBId: true } },
    },
  });
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId!).filter(Boolean) }, status: "CONFIRMED" },
    select: { id: true, playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
  });
  const matchById = new Map(matches.map((m) => [m.id, m]));

  // Enrich each set with the game counts (Match A/B are canonical-by-id, not the set's A/B)
  // and the seed slots for the slot-aware owner resolution. Sets missing a team/slot are
  // skipped (historical/team-only imports have no per-side seed).
  const slotted: SlottedSet[] = [];
  for (const s of sets) {
    const m = s.matchId ? matchById.get(s.matchId) : undefined;
    const teamA = s.teamSeasonAId ?? s.matchup?.teamSeasonAId ?? null;
    const teamB = s.teamSeasonBId ?? s.matchup?.teamSeasonBId ?? null;
    if (!m || teamA == null || teamB == null) continue;
    const gamesFor = (playerId: string) => (m.playerAId === playerId ? m.gamesWonA : m.playerBId === playerId ? m.gamesWonB : 0);
    slotted.push({
      playerAId: s.playerAId, teamSeasonAId: teamA, seedA: s.seedA, gamesA: gamesFor(s.playerAId),
      playerBId: s.playerBId, teamSeasonBId: teamB, seedB: s.seedB, gamesB: gamesFor(s.playerBId),
    });
  }

  const totals = tallyFantasyBySlot(
    slotted,
    (pid) => ownerByPlayer.get(pid) ?? null,
    (tid, seed) => ownerBySlot.get(`${tid}:${seed}`) ?? null,
    { setWinPoints: league.setWinPoints, gameWinPoints: league.gameWinPoints },
  );
  // Include managers with 0 points (drafted players who haven't scored yet).
  const scored = new Map(totals.map((t) => [t.managerId, t]));
  const standings = league.teams
    .map((t) => scored.get(t.name) ?? { managerId: t.name, points: 0, sets: 0 })
    .sort((a, b) => b.points - a.points || a.managerId.localeCompare(b.managerId));

  return { scope: league.scope, rosterSize: league.rosterSize, standings, setsCounted: slotted.length };
}

// Remove the fantasy league for a season (called by deleteSeason — plain-id, no cascade).
export async function deleteFantasyForSeason(seasonId: string) {
  await prisma.fantasyLeague.deleteMany({ where: { seasonId } });
}
