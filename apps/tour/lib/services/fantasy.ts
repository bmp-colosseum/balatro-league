// Fantasy service (ws08) — the shell around the pure scoring core (@balatro/tour-core
// fantasy). Managers draft real players; standings DERIVE on read from the season's sets,
// so a corrected result reflows automatically. Auth-agnostic (callers gate); the sim and
// the (future) UI/bot are thin callers of these functions.
import { prisma } from "../db";
import { snakeOrder, tallyFantasyBySlot, ownerAtWeek, type SlottedSet, type OwnershipMove } from "@balatro/tour-core";
import { notifyLive } from "../notify";

// One live league per season → one SSE scope. The draft board + standings page
// subscribe; every fantasy mutation notifies it post-commit.
const fantasyScope = (seasonId: string) => `fantasy:${seasonId}`;

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

// ── Live human snake draft (mirrors the real draft in lib/services/draft.ts) ──
// Managers self-serve JOIN while OPEN; the TO STARTS the draft (freezes the order);
// the on-the-clock manager PICKS from the real pool until every roster is full. No
// deadline/autopick — the clock is cosmetic ([[feedback_not_robotic]]).

// Pure on-the-clock math from the frozen order + how many picks are in (no I/O). The
// snake sequence is fully known, so the current slot is just index `madePicks` into it.
function onClockSlot(order: string[], rosterSize: number, madePicks: number) {
  const full = snakeOrder(order, rosterSize);
  if (madePicks >= full.length) return null; // board full → draft is DONE
  return {
    fantasyTeamId: full[madePicks],
    round: Math.floor(madePicks / order.length) + 1,
    overall: madePicks + 1,
    total: full.length,
  };
}

// Lock the league row for the duration of an interactive transaction, so join / remove /
// start can't interleave (Read Committed alone lets two of them both read a stale snapshot).
// The three mutators that change the roster set or freeze the order all take this lock, so a
// join can never land after the order is frozen (which would orphan a team and brick the draft).
async function lockLeague(tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }, leagueId: string) {
  await tx.$queryRaw`SELECT id FROM "FantasyLeague" WHERE id = ${leagueId} FOR UPDATE`;
}

// A community member claims a manager slot. Any signed-in Discord user may join while the
// league is OPEN; capacity = floor(pool / rosterSize) so every manager ends with a full roster.
// The count+create runs under the league row lock, so concurrent joins can't over-subscribe
// the cap, collide on joinOrder, or slip in after the draft starts.
export async function joinFantasyLeague(seasonName: string, manager: { discordId: string; name: string }) {
  const season = await seasonByName(seasonName);
  const discordId = (manager.discordId ?? "").trim();
  if (!discordId) throw new Error("Sign in with Discord to join.");
  const base = await prisma.fantasyLeague.findUnique({ where: { seasonId: season.id }, select: { id: true, rosterSize: true } });
  if (!base) throw new Error("No fantasy league is open for this season yet.");
  const pool = await getFantasyPool(seasonName); // pool is fixed by the real draft (stable)
  const cap = Math.floor(pool.length / base.rosterSize);
  const name = ((manager.name ?? "").trim() || discordId).slice(0, 40);

  const result = await prisma.$transaction(async (tx) => {
    await lockLeague(tx, base.id);
    const league = await tx.fantasyLeague.findUnique({
      where: { id: base.id },
      include: { teams: { select: { name: true, managerDiscordId: true } } },
    });
    if (!league) throw new Error("No fantasy league is open for this season yet.");
    if (league.draftStartedAt) throw new Error("The fantasy draft has already started - the manager list is locked.");
    if (league.teams.some((t) => t.managerDiscordId === discordId)) throw new Error("You're already a manager in this league.");
    if (league.teams.length >= cap) throw new Error(`This league is full (${cap} managers for a pool of ${pool.length} at roster ${league.rosterSize}).`);
    if (league.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error(`A manager named "${name}" is already in this league - pick another name.`);
    const team = await tx.fantasyTeam.create({
      data: { leagueId: league.id, managerDiscordId: discordId, name, joinOrder: league.teams.length + 1 },
      select: { id: true },
    });
    return { teamId: team.id, managerCount: league.teams.length + 1, cap };
  });
  await notifyLive(fantasyScope(season.id));
  return result;
}

// Drop a manager (TO only, pre-draft). Under the league lock so it can't race a start that
// would freeze the order with this team's now-deleted id (a dead id on the clock stalls the draft).
export async function removeFantasyTeam(teamId: string) {
  const team = await prisma.fantasyTeam.findUnique({
    where: { id: teamId },
    select: { id: true, league: { select: { id: true, seasonId: true } } },
  });
  if (!team) throw new Error("No such fantasy manager.");
  await prisma.$transaction(async (tx) => {
    await lockLeague(tx, team.league.id);
    const league = await tx.fantasyLeague.findUnique({ where: { id: team.league.id }, select: { draftStartedAt: true } });
    if (league?.draftStartedAt) throw new Error("The draft has started - managers can't be removed.");
    await tx.fantasyTeam.delete({ where: { id: teamId } });
  });
  await notifyLive(fantasyScope(team.league.seasonId));
}

// Lock the manager set, freeze the snake seed order (join order by default, or a TO-supplied
// permutation), and put manager #1 on the clock. Runs under the league lock and re-reads the
// team set inside the transaction, so the frozen order always covers exactly the current teams.
export async function startFantasyDraft(seasonName: string, order?: string[]) {
  const season = await seasonByName(seasonName);
  const base = await prisma.fantasyLeague.findUnique({ where: { seasonId: season.id }, select: { id: true, rosterSize: true } });
  if (!base) throw new Error("Open a fantasy league first.");
  const pool = await getFantasyPool(seasonName);
  const cap = Math.floor(pool.length / base.rosterSize);

  const result = await prisma.$transaction(async (tx) => {
    await lockLeague(tx, base.id);
    const league = await tx.fantasyLeague.findUnique({
      where: { id: base.id },
      include: { teams: { orderBy: [{ joinOrder: "asc" }, { createdAt: "asc" }], select: { id: true } } },
    });
    if (!league) throw new Error("Open a fantasy league first.");
    if (league.draftStartedAt) throw new Error("The fantasy draft has already started.");
    if (league.teams.length < 2) throw new Error("Need at least 2 managers to start the draft.");
    if (league.teams.length > cap) throw new Error(`Too many managers (${league.teams.length}) for the pool - at most ${cap}.`);

    // Frozen order: the TO's explicit list (must be exactly the current managers) or join order.
    const joinIds = league.teams.map((t) => t.id);
    let seedOrder = joinIds;
    if (order && order.length) {
      const a = [...order].sort();
      const b = [...joinIds].sort();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error("Draft order must list exactly the current managers.");
      seedOrder = order;
    }
    const now = new Date();
    await tx.fantasyLeague.update({
      where: { id: league.id },
      data: { draftStartedAt: now, orderJson: JSON.stringify(seedOrder), onClockSince: now },
    });
    return { teams: seedOrder.length, totalPicks: seedOrder.length * base.rosterSize };
  });
  await notifyLive(fantasyScope(season.id));
  return result;
}

// Who is on the clock right now (or null if not started / draft complete).
export async function onClockFantasyTeam(seasonName: string) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    include: { teams: { select: { id: true, managerDiscordId: true, _count: { select: { picks: true } } } } },
  });
  if (!league || !league.draftStartedAt || !league.orderJson) return null;
  const order = JSON.parse(league.orderJson) as string[];
  const madePicks = league.teams.reduce((n, t) => n + t._count.picks, 0);
  const slot = onClockSlot(order, league.rosterSize, madePicks);
  if (!slot) return null;
  const team = league.teams.find((t) => t.id === slot.fantasyTeamId);
  if (!team) return null;
  return { fantasyTeamId: slot.fantasyTeamId, managerDiscordId: team.managerDiscordId, round: slot.round, overall: slot.overall };
}

// One live pick. `actorDiscordId` is the signed-in manager (from getViewer — NEVER a form
// field). Enforces the three correctness properties the schema can't: turn order + ownership
// (only the on-clock manager), league-wide unique player ownership, and no double-pick (the
// [fantasyTeamId,pickIndex] unique index serializes concurrent submits → P2002).
export async function makeFantasyPick(seasonName: string, actorDiscordId: string, playerId: string) {
  const season = await seasonByName(seasonName);
  const actor = (actorDiscordId ?? "").trim();
  if (!actor) throw new Error("Sign in with Discord to draft.");

  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    include: { teams: { select: { id: true, managerDiscordId: true } } },
  });
  if (!league) throw new Error("No fantasy league for this season.");
  if (!league.draftStartedAt || !league.orderJson) throw new Error("The fantasy draft hasn't started yet.");

  // The pool is fixed by the real draft; look up the player's slot (real team + seed).
  const pool = await getFantasyPool(seasonName);
  const poolEntry = pool.find((p) => p.playerId === playerId);
  if (!poolEntry) throw new Error("That player isn't in the draft pool.");
  const order = JSON.parse(league.orderJson) as string[];

  let done: boolean;
  try {
    done = await prisma.$transaction(async (tx) => {
      const picks = await tx.fantasyPick.findMany({ where: { team: { leagueId: league.id } }, select: { playerId: true } });
      const madePicks = picks.length;
      const slot = onClockSlot(order, league.rosterSize, madePicks);
      if (!slot) throw new Error("The fantasy draft is already complete.");
      const onClock = league.teams.find((t) => t.id === slot.fantasyTeamId);
      if (!onClock || onClock.managerDiscordId !== actor) throw new Error("It's not your turn to pick.");
      if (picks.some((p) => p.playerId === playerId)) throw new Error("That player is already drafted.");

      await tx.fantasyPick.create({
        data: { fantasyTeamId: slot.fantasyTeamId, pickIndex: madePicks, playerId, teamSeasonId: poolEntry.teamSeasonId, seed: poolEntry.seed },
      });
      await tx.fantasyLeague.update({ where: { id: league.id }, data: { onClockSince: new Date() } });
      return madePicks + 1 >= slot.total;
    });
  } catch (e) {
    // Two submits raced onto the same slot — the unique index rejected the loser.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      throw new Error("That pick was just taken — refresh the board.");
    }
    throw e;
  }

  await notifyLive(fantasyScope(season.id));
  return { done };
}

// Live board read model (mirrors getDraft): teams with their picks, the remaining pool, who's
// on the clock, and the up-next ticker. null when no league exists.
export async function getFantasyDraftBoard(seasonName: string) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    include: {
      teams: {
        orderBy: [{ joinOrder: "asc" }, { createdAt: "asc" }],
        include: { picks: { orderBy: { pickIndex: "asc" }, select: { pickIndex: true, playerId: true, teamSeasonId: true, seed: true } } },
      },
    },
  });
  if (!league) return null;

  const pool = await getFantasyPool(seasonName); // {playerId,name,teamSeasonId,seed}
  const rosterSize = league.rosterSize;
  const cap = Math.floor(pool.length / rosterSize);
  const teamCount = league.teams.length;
  const total = teamCount * rosterSize;
  const madePicks = league.teams.reduce((n, t) => n + t.picks.length, 0);
  const state: "OPEN" | "DRAFTING" | "DONE" = !league.draftStartedAt ? "OPEN" : madePicks >= total ? "DONE" : "DRAFTING";

  // Names: the pool covers undrafted players; drafted ones are gone from it, so resolve them.
  const poolNameById = new Map(pool.map((p) => [p.playerId, p.name]));
  const pickedIds = league.teams.flatMap((t) => t.picks.map((p) => p.playerId));
  const missing = pickedIds.filter((id) => !poolNameById.has(id));
  const extra = missing.length ? await prisma.player.findMany({ where: { id: { in: missing } }, select: { id: true, displayName: true } }) : [];
  const nameById = new Map<string, string>(poolNameById);
  for (const p of extra) nameById.set(p.id, p.displayName);

  // Real-team names for the "from" label on each pick.
  const tsIds = [...new Set(pickedIds.length ? league.teams.flatMap((t) => t.picks.map((p) => p.teamSeasonId)) : [])];
  const teamSeasons = tsIds.length ? await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: { select: { name: true } } } }) : [];
  const realTeamName = new Map(teamSeasons.map((ts) => [ts.id, ts.team.name]));

  const order = league.orderJson ? (JSON.parse(league.orderJson) as string[]) : league.teams.map((t) => t.id);
  const slot = league.draftStartedAt ? onClockSlot(order, rosterSize, madePicks) : null;

  const teams = league.teams.map((t) => ({
    id: t.id,
    name: t.name,
    managerDiscordId: t.managerDiscordId,
    joinOrder: t.joinOrder,
    onClock: slot?.fantasyTeamId === t.id,
    picks: t.picks.map((p) => ({
      pickIndex: p.pickIndex,
      playerId: p.playerId,
      name: nameById.get(p.playerId) ?? p.playerId,
      seed: p.seed,
      teamName: realTeamName.get(p.teamSeasonId) ?? "",
    })),
  }));

  const taken = new Set(pickedIds);
  const boardPool = pool.filter((p) => !taken.has(p.playerId));

  const currentTeam = slot ? teams.find((t) => t.id === slot.fantasyTeamId) ?? null : null;
  const current = slot && currentTeam
    ? { fantasyTeamId: currentTeam.id, managerDiscordId: currentTeam.managerDiscordId, managerName: currentTeam.name, round: slot.round, overall: slot.overall, onClockSince: league.onClockSince }
    : null;

  const full = league.draftStartedAt ? snakeOrder(order, rosterSize) : [];
  const nameByTeamId = new Map(teams.map((t) => [t.id, t.name]));
  const upcoming = full.slice(madePicks + 1, madePicks + 6).map((tid, i) => ({ overall: madePicks + 2 + i, managerName: nameByTeamId.get(tid) ?? "?" }));

  return { seasonId: season.id, state, rosterSize, cap, teams, current, upcoming, pool: boardPool, totalPicks: total, madePicks };
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
    managers.map((m, i) => prisma.fantasyTeam.create({ data: { leagueId: league.id, managerDiscordId: m.discordId, name: m.name, joinOrder: i + 1 } })),
  );
  // Serpentine order over teams for rosterSize rounds → overall pick sequence.
  const seedOrder = teams.map((t) => t.id);
  const order = snakeOrder(seedOrder, league.rosterSize);
  await prisma.fantasyPick.createMany({
    data: order.map((fantasyTeamId, pickIndex) => {
      const p = pool[pickIndex];
      return { fantasyTeamId, pickIndex, playerId: p.playerId, teamSeasonId: p.teamSeasonId, seed: p.seed };
    }),
  });
  // Mark the (already-complete) draft as started so the board reads DONE, not OPEN.
  const now = new Date();
  await prisma.fantasyLeague.update({ where: { id: league.id }, data: { draftStartedAt: now, orderJson: JSON.stringify(seedOrder), onClockSince: now } });
  return { league: league.id, managers: teams.length, picks: order.length };
}

// Time-effective fantasy ownership (mirrors seedAtWeekResolver in roster-ops): base = each
// player's DRAFT owner (from FantasyPick), then fold APPLIED trades so byPlayer/bySlot resolve
// who owned a player/slot AS OF a given week. A league with no APPLIED trades resolves to the
// draft owner for every week -> standings are identical to the pre-trades behavior. A trade
// moves the pick (player + its slot) wholesale, so byPlayer and bySlot fold identically.
async function fantasyOwnerAtWeekResolver(leagueId: string) {
  const picks = await prisma.fantasyPick.findMany({
    where: { team: { leagueId } },
    select: { playerId: true, teamSeasonId: true, seed: true, fantasyTeamId: true },
  });
  const base = new Map<string, string>(); // playerId -> draft owner (fantasyTeamId)
  const playerForSlot = new Map<string, string>(); // `${teamSeasonId}:${seed}` -> playerId
  for (const p of picks) {
    base.set(p.playerId, p.fantasyTeamId);
    playerForSlot.set(`${p.teamSeasonId}:${p.seed}`, p.playerId);
  }
  const trades = await prisma.fantasyTrade.findMany({
    where: { leagueId, status: "APPLIED" },
    orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
    select: { effectiveWeek: true, items: { select: { playerId: true, toTeamId: true } } },
  });
  const moves: OwnershipMove[] = [];
  let seq = 0;
  for (const t of trades) {
    for (const it of t.items) moves.push({ playerId: it.playerId, toTeamId: it.toTeamId, effectiveWeek: t.effectiveWeek ?? 0, seq: seq++ });
  }
  const byPlayer = (playerId: string, week: number | null) => ownerAtWeek(base, moves, playerId, week);
  const bySlot = (teamSeasonId: string, seed: number, week: number | null) => {
    const pid = playerForSlot.get(`${teamSeasonId}:${seed}`);
    return pid ? ownerAtWeek(base, moves, pid, week) : null;
  };
  // Owner "right now" = fold at an effectively-infinite week (all applied trades in force).
  const currentOwner = (playerId: string) => ownerAtWeek(base, moves, playerId, Number.MAX_SAFE_INTEGER);
  return { byPlayer, bySlot, currentOwner };
}

// The latest schedule week with a decided set (0 if none) — "now" for trade timing.
async function currentFantasyWeek(seasonId: string): Promise<number> {
  const sets = await prisma.tourSet.findMany({
    where: { matchId: { not: null }, OR: [{ seasonId }, { matchup: { week: { seasonId } } }] },
    select: { week: true, matchup: { select: { week: { select: { number: true } } } } },
  });
  let max = 0;
  for (const s of sets) {
    const w = s.matchup?.week?.number ?? s.week ?? 0;
    if (w > max) max = w;
  }
  return max;
}

// Cumulative standings — derive on read. Loads the in-scope decided sets, maps each set's
// real players to their fantasy owner AS OF that set's week (so a mid-season trade only moves
// points from its effective week forward), and tallies via the pure core. SEASON = every set;
// PLAYOFFS = only playoff-week sets (eliminated players simply have no more sets).
export async function getFantasyStandings(seasonName: string) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    select: {
      scope: true, rosterSize: true, setWinPoints: true, gameWinPoints: true, id: true,
      teams: { select: { id: true, name: true, managerDiscordId: true } },
    },
  });
  if (!league) return null;

  const owner = await fantasyOwnerAtWeekResolver(league.id);

  // In-scope decided sets (have a linked core Match). Playoff scope filters by week kind.
  const sets = await prisma.tourSet.findMany({
    where: {
      matchId: { not: null },
      OR: [{ seasonId: season.id }, { matchup: { week: { seasonId: season.id } } }],
      ...(league.scope === "PLAYOFFS" ? { matchup: { week: { kind: "PLAYOFF" } } } : {}),
    },
    select: {
      playerAId: true, playerBId: true, seedA: true, seedB: true,
      teamSeasonAId: true, teamSeasonBId: true, matchId: true, week: true,
      // Live sets carry their team link + week on the matchup (the set's own columns are for
      // historical imports); set side A == matchup team A (schema §TourSet).
      matchup: { select: { teamSeasonAId: true, teamSeasonBId: true, week: { select: { number: true } } } },
    },
  });
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId!).filter(Boolean) }, status: "CONFIRMED" },
    select: { id: true, playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
  });
  const matchById = new Map(matches.map((m) => [m.id, m]));

  // Enrich each set with the game counts (Match A/B are canonical-by-id, not the set's A/B),
  // the seed slots, and the WEEK (for time-effective ownership). Sets missing a team/slot are
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
      week: s.matchup?.week?.number ?? s.week ?? null,
    });
  }

  const totals = tallyFantasyBySlot(
    slotted,
    owner.byPlayer,
    owner.bySlot,
    { setWinPoints: league.setWinPoints, gameWinPoints: league.gameWinPoints },
  );
  // Include managers with 0 points (drafted players who haven't scored yet). Points/sets
  // come from the id-keyed tally; name/discordId are for display.
  const scored = new Map(totals.map((t) => [t.managerId, t]));
  const standings = league.teams
    .map((t) => {
      const s = scored.get(t.id);
      return {
        teamId: t.id,
        managerName: t.name,
        managerDiscordId: t.managerDiscordId,
        points: s?.points ?? 0,
        sets: s?.sets ?? 0,
      };
    })
    .sort((a, b) => b.points - a.points || a.managerName.localeCompare(b.managerName));

  return { scope: league.scope, rosterSize: league.rosterSize, standings, setsCounted: slotted.length };
}

// ── Trades + weekly lock ─────────────────────────────────────────────────────
// A trade re-attributes ownership from an effective week forward (standings fold it via the
// resolver above); it never mutates FantasyPick. Managers propose/accept; AUTO applies on
// accept, TO_APPROVED waits for a TO. The weekly lock (lockedThroughWeek) is the freeze
// boundary: an APPLIED trade always lands after it, so a scored week never reflows.

async function fantasyLeagueForTrade(seasonName: string) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    select: { id: true, tradesEnabled: true, tradeApproval: true, tradeDeadlineWeek: true, lockedThroughWeek: true },
  });
  if (!league) throw new Error("No fantasy league for this season.");
  return { season, league };
}

// The signed-in viewer's team in this league (or null).
async function teamOfViewer(leagueId: string, discordId: string | null) {
  if (!discordId) return null;
  return prisma.fantasyTeam.findFirst({ where: { leagueId, managerDiscordId: discordId }, select: { id: true, name: true } });
}

// Propose a trade: proposer gives `give[]` (their players) for the receiver's `receive[]`. An
// even swap keeps both rosters full. Ownership is validated NOW; the trade only lands (effective
// week) when it becomes APPLIED. N-for-N capable; the MVP UI is 1-for-1.
export async function proposeTrade(
  seasonName: string,
  proposerDiscordId: string,
  input: { receiverTeamId: string; give: string[]; receive: string[]; reason?: string },
) {
  const { season, league } = await fantasyLeagueForTrade(seasonName);
  if (!league.tradesEnabled) throw new Error("Trades are turned off for this league.");
  const give = [...new Set(input.give.filter(Boolean))];
  const receive = [...new Set(input.receive.filter(Boolean))];
  if (!give.length || !receive.length) throw new Error("Pick at least one player on each side.");
  if (give.length !== receive.length) throw new Error("A trade must be an even swap (same number of players each way).");

  const proposer = await teamOfViewer(league.id, proposerDiscordId);
  if (!proposer) throw new Error("You're not a manager in this league.");
  if (input.receiverTeamId === proposer.id) throw new Error("Pick another manager to trade with.");
  const receiver = await prisma.fantasyTeam.findFirst({ where: { id: input.receiverTeamId, leagueId: league.id }, select: { id: true, name: true } });
  if (!receiver) throw new Error("That manager isn't in this league.");

  const week = await currentFantasyWeek(season.id);
  if (league.tradeDeadlineWeek != null && week > league.tradeDeadlineWeek) throw new Error(`The trade deadline (week ${league.tradeDeadlineWeek}) has passed.`);

  // Ownership must hold right now (folding prior applied trades).
  const owner = await fantasyOwnerAtWeekResolver(league.id);
  for (const pid of give) if (owner.currentOwner(pid) !== proposer.id) throw new Error("You can only offer players you currently own.");
  for (const pid of receive) if (owner.currentOwner(pid) !== receiver.id) throw new Error("That manager doesn't currently own one of the requested players.");

  const trade = await prisma.fantasyTrade.create({
    data: {
      leagueId: league.id,
      proposerTeamId: proposer.id,
      receiverTeamId: receiver.id,
      status: "PROPOSED",
      proposedByDiscordId: proposerDiscordId,
      reason: input.reason?.slice(0, 300) || null,
      items: {
        create: [
          ...give.map((playerId) => ({ playerId, fromTeamId: proposer.id, toTeamId: receiver.id })),
          ...receive.map((playerId) => ({ playerId, fromTeamId: receiver.id, toTeamId: proposer.id })),
        ],
      },
    },
    select: { id: true },
  });
  await notifyLive(fantasyScope(season.id));
  return { tradeId: trade.id };
}

// Transition a trade to APPLIED under the league lock: set effectiveWeek = after the lock/now,
// re-validate that each giver STILL owns their side (no stale double-trade), then flip status.
// This is the only step that changes ownership.
async function applyTradeUnderLock(seasonId: string, tradeId: string) {
  const head = await prisma.fantasyTrade.findUnique({ where: { id: tradeId }, select: { leagueId: true } });
  if (!head) throw new Error("Trade not found.");
  const week = await currentFantasyWeek(seasonId);
  await prisma.$transaction(async (tx) => {
    await lockLeague(tx, head.leagueId);
    const trade = await tx.fantasyTrade.findUnique({
      where: { id: tradeId },
      select: { status: true, items: { select: { playerId: true, fromTeamId: true } }, league: { select: { lockedThroughWeek: true, tradesEnabled: true } } },
    });
    if (!trade) throw new Error("Trade not found.");
    if (trade.status !== "PROPOSED" && trade.status !== "TO_REVIEW") throw new Error("This trade can no longer be applied.");
    if (!trade.league.tradesEnabled) throw new Error("Trades are turned off for this league.");

    // Current owners (fold APPLIED trades), tx-consistent, to catch a stale offer.
    const picks = await tx.fantasyPick.findMany({ where: { team: { leagueId: head.leagueId } }, select: { playerId: true, fantasyTeamId: true } });
    const base = new Map(picks.map((p) => [p.playerId, p.fantasyTeamId] as [string, string]));
    const applied = await tx.fantasyTrade.findMany({
      where: { leagueId: head.leagueId, status: "APPLIED" },
      orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }],
      select: { effectiveWeek: true, items: { select: { playerId: true, toTeamId: true } } },
    });
    const moves: OwnershipMove[] = [];
    let seq = 0;
    for (const t of applied) for (const it of t.items) moves.push({ playerId: it.playerId, toTeamId: it.toTeamId, effectiveWeek: t.effectiveWeek ?? 0, seq: seq++ });
    for (const it of trade.items) {
      if (ownerAtWeek(base, moves, it.playerId, Number.MAX_SAFE_INTEGER) !== it.fromTeamId) throw new Error("A player in this trade was already moved - the offer is stale.");
    }

    const effectiveWeek = Math.max(trade.league.lockedThroughWeek, week) + 1;
    // Compare-and-set on status. cancel/reject don't take the league lock, so one can commit
    // between the status read above and this write. Conditioning on the still-open status makes
    // the APPLIED transition atomic - it matches 0 rows (and we abort) if the trade was just
    // cancelled/rejected/applied, instead of resurrecting a resolved offer to APPLIED.
    const res = await tx.fantasyTrade.updateMany({
      where: { id: tradeId, status: { in: ["PROPOSED", "TO_REVIEW"] } },
      data: { status: "APPLIED", effectiveWeek, decidedAt: new Date() },
    });
    if (res.count !== 1) throw new Error("This trade was just resolved - refresh and try again.");
  });
}

// The receiving manager accepts or rejects. AUTO league -> applies now; TO_APPROVED -> queues
// for a TO. Identity is the caller's discordId (gated by the action), never form data.
export async function respondToTrade(tradeId: string, viewerDiscordId: string, accept: boolean) {
  const trade = await prisma.fantasyTrade.findUnique({
    where: { id: tradeId },
    select: { status: true, receiverTeamId: true, leagueId: true, league: { select: { seasonId: true, tradeApproval: true } } },
  });
  if (!trade) throw new Error("Trade not found.");
  if (trade.status !== "PROPOSED") throw new Error("This trade isn't awaiting a response.");
  const myTeam = await teamOfViewer(trade.leagueId, viewerDiscordId);
  if (!myTeam || myTeam.id !== trade.receiverTeamId) throw new Error("Only the receiving manager can respond to this offer.");

  // Compare-and-set on status=PROPOSED so a race with the proposer's cancel resolves to exactly
  // one outcome (whichever commits first wins; the loser matches 0 rows and errors out).
  if (!accept) {
    const res = await prisma.fantasyTrade.updateMany({ where: { id: tradeId, status: "PROPOSED" }, data: { status: "REJECTED", decidedAt: new Date() } });
    if (res.count !== 1) throw new Error("This trade isn't awaiting a response.");
    await notifyLive(fantasyScope(trade.league.seasonId));
    return { status: "REJECTED" as const };
  }
  if (trade.league.tradeApproval === "TO_APPROVED") {
    const res = await prisma.fantasyTrade.updateMany({ where: { id: tradeId, status: "PROPOSED" }, data: { status: "TO_REVIEW", decidedAt: new Date() } });
    if (res.count !== 1) throw new Error("This trade isn't awaiting a response.");
    await notifyLive(fantasyScope(trade.league.seasonId));
    return { status: "TO_REVIEW" as const };
  }
  await applyTradeUnderLock(trade.league.seasonId, tradeId);
  await notifyLive(fantasyScope(trade.league.seasonId));
  return { status: "APPLIED" as const };
}

// The proposer withdraws a still-open offer.
export async function cancelTrade(tradeId: string, viewerDiscordId: string) {
  const trade = await prisma.fantasyTrade.findUnique({ where: { id: tradeId }, select: { status: true, proposerTeamId: true, leagueId: true, league: { select: { seasonId: true } } } });
  if (!trade) throw new Error("Trade not found.");
  if (trade.status !== "PROPOSED" && trade.status !== "TO_REVIEW") throw new Error("This trade can't be cancelled now.");
  const myTeam = await teamOfViewer(trade.leagueId, viewerDiscordId);
  if (!myTeam || myTeam.id !== trade.proposerTeamId) throw new Error("Only the proposer can cancel this offer.");
  // Compare-and-set: if the receiver's accept/reject (or a TO decision) just landed, this matches
  // 0 rows and we refuse - a bare update-by-id would clobber an already-APPLIED trade back to
  // CANCELLED and silently revert the ownership transfer.
  const res = await prisma.fantasyTrade.updateMany({ where: { id: tradeId, status: { in: ["PROPOSED", "TO_REVIEW"] } }, data: { status: "CANCELLED", decidedAt: new Date() } });
  if (res.count !== 1) throw new Error("This trade can't be cancelled now - it was just resolved.");
  await notifyLive(fantasyScope(trade.league.seasonId));
}

// TO approves/rejects a queued trade (TO_APPROVED leagues). Caller gates isAdmin().
export async function decideTradeAsTO(tradeId: string, approve: boolean) {
  const trade = await prisma.fantasyTrade.findUnique({ where: { id: tradeId }, select: { status: true, league: { select: { seasonId: true } } } });
  if (!trade) throw new Error("Trade not found.");
  if (trade.status !== "TO_REVIEW") throw new Error("This trade isn't awaiting TO review.");
  if (!approve) {
    // CAS: lose to a proposer cancel that raced this decision (both target the TO_REVIEW row).
    const res = await prisma.fantasyTrade.updateMany({ where: { id: tradeId, status: "TO_REVIEW" }, data: { status: "REJECTED", decidedAt: new Date() } });
    if (res.count !== 1) throw new Error("This trade isn't awaiting TO review.");
    await notifyLive(fantasyScope(trade.league.seasonId));
    return { status: "REJECTED" as const };
  }
  await applyTradeUnderLock(trade.league.seasonId, tradeId);
  await notifyLive(fantasyScope(trade.league.seasonId));
  return { status: "APPLIED" as const };
}

// TO advances the weekly freeze. Applied trades already landed after the old lock stay put;
// this only affects where FUTURE trades land. Caller gates isAdmin().
export async function advanceFantasyLock(seasonName: string, throughWeek: number) {
  const { season, league } = await fantasyLeagueForTrade(seasonName);
  const w = Math.max(0, Math.floor(Number(throughWeek) || 0));
  await prisma.fantasyLeague.update({ where: { id: league.id }, data: { lockedThroughWeek: w } });
  await notifyLive(fantasyScope(season.id));
  return { lockedThroughWeek: w };
}

// TO trade settings. Caller gates isAdmin().
export async function setFantasyTradeConfig(seasonName: string, cfg: { tradesEnabled?: boolean; tradeApproval?: "AUTO" | "TO_APPROVED"; tradeDeadlineWeek?: number | null }) {
  const { season, league } = await fantasyLeagueForTrade(seasonName);
  await prisma.fantasyLeague.update({
    where: { id: league.id },
    data: {
      ...(cfg.tradesEnabled != null ? { tradesEnabled: cfg.tradesEnabled } : {}),
      ...(cfg.tradeApproval ? { tradeApproval: cfg.tradeApproval } : {}),
      ...(cfg.tradeDeadlineWeek !== undefined ? { tradeDeadlineWeek: cfg.tradeDeadlineWeek } : {}),
    },
  });
  await notifyLive(fantasyScope(season.id));
}

// One trade, oriented for display (player names + team names on each side).
export interface TradeView {
  id: string;
  status: string;
  effectiveWeek: number | null;
  reason: string | null;
  proposer: string;
  receiver: string;
  fromProposer: string[]; // players the proposer gives up
  fromReceiver: string[]; // players the receiver gives up
}

// Manager trade panel (public fantasy page): current rosters (post-trades), other managers to
// trade with, and this viewer's incoming / outgoing / historical trades.
export async function getFantasyTradePanel(seasonName: string, viewerDiscordId: string | null) {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({
    where: { seasonId: season.id },
    select: {
      id: true, tradesEnabled: true, tradeApproval: true, tradeDeadlineWeek: true,
      teams: { select: { id: true, name: true, managerDiscordId: true } },
    },
  });
  if (!league) return null;
  const myTeam = viewerDiscordId ? league.teams.find((t) => t.managerDiscordId === viewerDiscordId) ?? null : null;
  const week = await currentFantasyWeek(season.id);
  const deadlinePassed = league.tradeDeadlineWeek != null && week > league.tradeDeadlineWeek;

  // Current rosters (post-trades) + player names.
  const owner = await fantasyOwnerAtWeekResolver(league.id);
  const picks = await prisma.fantasyPick.findMany({ where: { team: { leagueId: league.id } }, select: { playerId: true } });
  const playerIds = [...new Set(picks.map((p) => p.playerId))];
  const players = await prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const rosterByTeam = new Map<string, { playerId: string; name: string }[]>();
  for (const t of league.teams) rosterByTeam.set(t.id, []);
  for (const pid of playerIds) {
    const o = owner.currentOwner(pid);
    if (o && rosterByTeam.has(o)) rosterByTeam.get(o)!.push({ playerId: pid, name: nameOf.get(pid) ?? pid });
  }
  for (const arr of rosterByTeam.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

  const teamName = new Map(league.teams.map((t) => [t.id, t.name]));
  const trades = await prisma.fantasyTrade.findMany({
    where: { leagueId: league.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, proposerTeamId: true, receiverTeamId: true, effectiveWeek: true, reason: true, items: { select: { playerId: true, fromTeamId: true } } },
  });
  const toView = (t: (typeof trades)[number]): TradeView => ({
    id: t.id, status: t.status, effectiveWeek: t.effectiveWeek, reason: t.reason,
    proposer: teamName.get(t.proposerTeamId) ?? "?", receiver: teamName.get(t.receiverTeamId) ?? "?",
    fromProposer: t.items.filter((i) => i.fromTeamId === t.proposerTeamId).map((i) => nameOf.get(i.playerId) ?? i.playerId),
    fromReceiver: t.items.filter((i) => i.fromTeamId === t.receiverTeamId).map((i) => nameOf.get(i.playerId) ?? i.playerId),
  });
  const mine = myTeam ? trades.filter((t) => t.proposerTeamId === myTeam.id || t.receiverTeamId === myTeam.id) : [];

  return {
    enabled: league.tradesEnabled,
    deadlinePassed,
    tradeApproval: league.tradeApproval,
    myTeam: myTeam ? { id: myTeam.id, name: myTeam.name } : null,
    managers: league.teams.filter((t) => !myTeam || t.id !== myTeam.id).map((t) => ({ id: t.id, name: t.name })),
    myRoster: myTeam ? rosterByTeam.get(myTeam.id) ?? [] : [],
    rosterByTeam: Object.fromEntries([...rosterByTeam.entries()]) as Record<string, { playerId: string; name: string }[]>,
    incoming: myTeam ? mine.filter((t) => t.receiverTeamId === myTeam.id && t.status === "PROPOSED").map(toView) : [],
    outgoing: myTeam ? mine.filter((t) => t.proposerTeamId === myTeam.id && (t.status === "PROPOSED" || t.status === "TO_REVIEW")).map(toView) : [],
    history: myTeam ? mine.filter((t) => t.status === "APPLIED" || t.status === "REJECTED" || t.status === "CANCELLED").map(toView) : [],
  };
}

// TO review queue (TO_APPROVED leagues): trades a receiver accepted, awaiting a TO decision.
export async function getFantasyTradesForAdmin(seasonName: string): Promise<TradeView[]> {
  const season = await seasonByName(seasonName);
  const league = await prisma.fantasyLeague.findUnique({ where: { seasonId: season.id }, select: { id: true, teams: { select: { id: true, name: true } } } });
  if (!league) return [];
  const trades = await prisma.fantasyTrade.findMany({
    where: { leagueId: league.id, status: "TO_REVIEW" },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, proposerTeamId: true, receiverTeamId: true, effectiveWeek: true, reason: true, items: { select: { playerId: true, fromTeamId: true } } },
  });
  const teamName = new Map(league.teams.map((t) => [t.id, t.name]));
  const pids = [...new Set(trades.flatMap((t) => t.items.map((i) => i.playerId)))];
  const players = await prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  return trades.map((t) => ({
    id: t.id, status: t.status, effectiveWeek: t.effectiveWeek, reason: t.reason,
    proposer: teamName.get(t.proposerTeamId) ?? "?", receiver: teamName.get(t.receiverTeamId) ?? "?",
    fromProposer: t.items.filter((i) => i.fromTeamId === t.proposerTeamId).map((i) => nameOf.get(i.playerId) ?? i.playerId),
    fromReceiver: t.items.filter((i) => i.fromTeamId === t.receiverTeamId).map((i) => nameOf.get(i.playerId) ?? i.playerId),
  }));
}

// Remove the fantasy league for a season (called by deleteSeason — plain-id, no cascade).
export async function deleteFantasyForSeason(seasonId: string) {
  await prisma.fantasyLeague.deleteMany({ where: { seasonId } });
}
