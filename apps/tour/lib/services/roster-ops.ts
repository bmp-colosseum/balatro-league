// Weekly roster model (§B7). The lineup for any week is DERIVED by folding an
// append-only RosterMove log — never stored, never deleted, so history is total
// and the log itself is the timeline. Stat ATTRIBUTION (which team a player is on
// for the season) stays in RosterEntry, which is left untouched; this layer is
// purely lineup-over-time. One team per season, so a player is on at most one team.
import { prisma } from "../db";
import { notifyLive } from "../notify";
import { enqueueRoleReconcile } from "../queue";
import { getSeasonStrikeCounts, getCareerStrikeCounts, getSeasonStrikeLog, AT_RISK_THRESHOLD } from "./strikes";

// Roster mutations change who should hold the season's Discord roles — nudge the bot.
// Fire-and-forget (enqueueRoleReconcile never throws).
const queueRoleSync = (seasonName: string) => enqueueRoleReconcile(seasonName);

export const KIND_LABEL: Record<string, string> = {
  DRAFTED: "Drafted",
  ADDED: "Added",
  SUB: "Sub",
  QUIT: "Quit",
  BANNED: "Banned",
  REINSTATED: "Reinstated",
  CAPTAIN_CHANGE: "Captain",
  RESEED: "Re-seed",
};

export interface LineupPlayer {
  playerId: string;
  seed: number;
  isCaptain: boolean;
  viaSub: boolean;
}

interface MoveRow {
  id: string;
  playerId: string;
  outPlayerId: string | null;
  replacesPlayerId: string | null;
  kind: string;
  effectiveWeek: number;
  untilWeek: number | null;
  seed: number | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
}

// Fold a team's move log into the active lineup for `week`. Base = permanent
// members (DRAFTED/ADDED) who've joined and not permanently left (QUIT/BANNED,
// unless later REINSTATED); temporary SUBs overlay for the weeks they cover.
export function deriveLineup(moves: MoveRow[], week: number, captainId: string): LineupPlayer[] {
  const joinSeed = new Map<string, { week: number; seed: number }>();
  for (const m of moves) {
    if (m.kind === "DRAFTED" || m.kind === "ADDED") {
      const prev = joinSeed.get(m.playerId);
      if (!prev || m.effectiveWeek < prev.week) joinSeed.set(m.playerId, { week: m.effectiveWeek, seed: m.seed ?? 99 });
    }
  }
  const gone = new Map<string, boolean>();
  const reseed = new Map<string, number>(); // playerId → latest seed (RESEED ≤ week)
  for (const m of [...moves].sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)) {
    if (m.effectiveWeek > week) continue;
    if (m.kind === "QUIT" || m.kind === "BANNED") gone.set(m.playerId, true);
    else if (m.kind === "REINSTATED") gone.set(m.playerId, false);
    else if (m.kind === "RESEED" && m.seed != null) reseed.set(m.playerId, m.seed);
  }

  const lineup = new Map<string, LineupPlayer>();
  for (const [pid, js] of joinSeed) {
    if (js.week <= week && !gone.get(pid)) lineup.set(pid, { playerId: pid, seed: reseed.get(pid) ?? js.seed, isCaptain: pid === captainId, viaSub: false });
  }
  for (const m of [...moves].filter((x) => x.kind === "SUB").sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)) {
    const last = m.untilWeek ?? m.effectiveWeek;
    if (m.effectiveWeek <= week && week <= last) {
      const seed = m.seed ?? (m.outPlayerId ? lineup.get(m.outPlayerId)?.seed : undefined) ?? 99;
      if (m.outPlayerId) lineup.delete(m.outPlayerId);
      lineup.set(m.playerId, { playerId: m.playerId, seed, isCaptain: m.playerId === captainId, viaSub: true });
    }
  }
  return [...lineup.values()].sort((a, b) => a.seed - b.seed);
}

// Who is captain in a given week — folds CAPTAIN_CHANGE moves (latest ≤ week),
// falling back to the captain before the first change, else the current pointer.
export function captainAtWeek(moves: MoveRow[], week: number, currentCaptain: string): string {
  const changes = moves.filter((m) => m.kind === "CAPTAIN_CHANGE").sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt);
  if (changes.length === 0) return currentCaptain;
  let cap = changes[0]!.replacesPlayerId ?? currentCaptain;
  for (const c of changes) {
    if (c.effectiveWeek <= week) cap = c.playerId;
    else break;
  }
  return cap ?? currentCaptain;
}

// The derived lineup for one team in one week (used by the pairing tool).
export async function rosterForWeek(teamSeasonId: string, week: number): Promise<LineupPlayer[]> {
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, select: { captainPlayerId: true } });
  if (!ts) return [];
  const moves = await prisma.rosterMove.findMany({ where: { teamSeasonId }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] });
  return deriveLineup(moves, week, captainAtWeek(moves, week, ts.captainPlayerId));
}

// Build a reusable resolver for a player's EFFECTIVE seed as of a given week across many
// team-seasons — folds the RosterMove log (RESEED / subs) and falls back to the static
// draft seed. Loads everything once; deriveLineup results are cached per team+week.
export async function seedAtWeekResolver(teamSeasonIds: string[]): Promise<(teamSeasonId: string | null, week: number, playerId: string) => number | null> {
  const ids = [...new Set(teamSeasonIds)].filter(Boolean);
  if (!ids.length) return () => null;
  const [moveRows, capRows, entries] = await Promise.all([
    prisma.rosterMove.findMany({ where: { teamSeasonId: { in: ids } }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] }),
    prisma.teamSeason.findMany({ where: { id: { in: ids } }, select: { id: true, captainPlayerId: true } }),
    prisma.rosterEntry.findMany({ where: { roster: { teamSeasonId: { in: ids } } }, select: { playerId: true, seed: true, roster: { select: { teamSeasonId: true } } } }),
  ]);
  const movesByTs = new Map<string, typeof moveRows>();
  for (const m of moveRows) (movesByTs.get(m.teamSeasonId) ?? movesByTs.set(m.teamSeasonId, []).get(m.teamSeasonId)!).push(m);
  const capByTs = new Map(capRows.map((c) => [c.id, c.captainPlayerId]));
  const staticSeed = new Map<string, number>();
  for (const e of entries) staticSeed.set(`${e.roster.teamSeasonId}|${e.playerId}`, e.seed);
  // The static RosterEntry fallback is only truthful for PERMANENT members (subs keep an
  // entry for stat attribution, but its seed is an import artifact, not a seed they held).
  const hasArrival = new Set(moveRows.filter((m) => m.kind === "DRAFTED" || m.kind === "ADDED").map((m) => `${m.teamSeasonId}|${m.playerId}`));
  const cache = new Map<string, Map<string, number>>();
  return (teamSeasonId, week, playerId) => {
    if (!teamSeasonId) return null;
    const k = `${teamSeasonId}|${week}`;
    let lm = cache.get(k);
    if (!lm) {
      const moves = movesByTs.get(teamSeasonId) ?? [];
      const lineup = deriveLineup(moves, week, captainAtWeek(moves, week, capByTs.get(teamSeasonId) ?? ""));
      lm = new Map(lineup.map((l) => [l.playerId, l.seed]));
      cache.set(k, lm);
    }
    const key = `${teamSeasonId}|${playerId}`;
    return lm.get(playerId) ?? (hasArrival.has(key) ? staticSeed.get(key) ?? null : null);
  };
}

// Designate / remove a co-captain — same team-scoped powers as the captain (permissions
// resolve via RosterEntry.isCoCaptain), without transferring the captaincy itself.
export async function setCoCaptain(teamSeasonId: string, playerId: string, isCoCaptain: boolean) {
  if (!playerId) throw new Error("Pick a player.");
  const entries = await prisma.rosterEntry.findMany({ where: { playerId, roster: { teamSeasonId } }, select: { id: true } });
  if (!entries.length) throw new Error("That player isn't on this team's roster.");
  await prisma.rosterEntry.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { isCoCaptain } });
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, select: { season: { select: { name: true } } } });
  if (ts) await queueRoleSync(ts.season.name);
  return { ok: true };
}

// Captaincy passes to a rostered player, effective a week. Logs a CAPTAIN_CHANGE
// (for the timeline) and updates the current-captain pointer. TO-assigned.
export async function changeCaptain(seasonName: string, teamSeasonId: string, newCaptainPlayerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!newCaptainPlayerId) throw new Error("Pick the new captain.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, select: { captainPlayerId: true } });
  if (!ts) throw new Error("No such team.");
  if (ts.captainPlayerId === newCaptainPlayerId) throw new Error("That player is already the captain.");
  await prisma.rosterMove.create({
    data: { seasonId, teamSeasonId, kind: "CAPTAIN_CHANGE", playerId: newCaptainPlayerId, replacesPlayerId: ts.captainPlayerId, effectiveWeek, reason: reason.trim() || "captain change", createdBy: by },
  });
  await prisma.teamSeason.update({ where: { id: teamSeasonId }, data: { captainPlayerId: newCaptainPlayerId } });
  await queueRoleSync(seasonName);
  return { ok: true };
}

// Change a rostered player's intra-team seed, effective a week. Logs a RESEED move;
// the weekly derivation overrides their seed from that week on (the ±2 pairing uses
// the seed of the matchup's week, so it picks up the new value automatically).
export async function reseed(seasonName: string, teamSeasonId: string, playerId: string, newSeed: number, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerId) throw new Error("Pick the player to re-seed.");
  if (!Number.isInteger(newSeed) || newSeed < 1) throw new Error("Seed must be a whole number ≥ 1.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  await prisma.rosterMove.create({
    data: { seasonId, teamSeasonId, kind: "RESEED", playerId, seed: newSeed, effectiveWeek, reason: reason.trim() || `re-seed to #${newSeed}`, createdBy: by },
  });
  return { ok: true };
}

// Swap two rostered players' seeds, effective a week — the common re-seed (one up, one
// down). Reads their CURRENT seeds for that week and logs a RESEED for each, trading
// them, so seeds stay unique and the matchup view picks up the new values from that week.
export async function swapSeeds(seasonName: string, teamSeasonId: string, playerAId: string, playerBId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerAId || !playerBId) throw new Error("Pick both players to swap.");
  if (playerAId === playerBId) throw new Error("Pick two different players.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  const lineup = await rosterForWeek(teamSeasonId, effectiveWeek); // their seeds as they stand that week
  const seedOf = new Map(lineup.map((l) => [l.playerId, l.seed]));
  const sa = seedOf.get(playerAId), sb = seedOf.get(playerBId);
  if (sa == null || sb == null) throw new Error("Both players must be in the lineup that week.");
  const why = reason.trim() || `swap seeds #${sa} <-> #${sb}`;
  await prisma.rosterMove.createMany({
    data: [
      { seasonId, teamSeasonId, kind: "RESEED", playerId: playerAId, seed: sb, effectiveWeek, reason: why, createdBy: by },
      { seasonId, teamSeasonId, kind: "RESEED", playerId: playerBId, seed: sa, effectiveWeek, reason: why, createdBy: by },
    ],
  });
  return { ok: true };
}

// ── Membership (stat attribution) — add a player to the team's roster so their
// sets attribute. RosterEntry is the season membership; never removed on departure.
export async function ensureMembership(teamSeasonId: string, playerId: string, seed: number) {
  let roster = await prisma.roster.findFirst({ where: { teamSeasonId }, orderBy: { weekBlock: "asc" } });
  if (!roster) roster = await prisma.roster.create({ data: { teamSeasonId, weekBlock: "SEASON" } });
  await prisma.rosterEntry.upsert({
    where: { rosterId_playerId: { rosterId: roster.id, playerId } },
    create: { rosterId: roster.id, playerId, seed, isCaptain: false },
    update: {},
  });
}

async function seasonIdOf(seasonName: string) {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!s) throw new Error(`No season "${seasonName}"`);
  return s.id;
}

async function seedOfMember(teamSeasonId: string, playerId: string): Promise<number> {
  const moves = await prisma.rosterMove.findMany({ where: { teamSeasonId, playerId, kind: { in: ["DRAFTED", "ADDED"] } } });
  return moves.sort((a, b) => a.effectiveWeek - b.effectiveWeek)[0]?.seed ?? 99;
}

// ── TO operations (each appends a move; nothing is deleted) ──────────────────

// A roster change must reach the SCHEDULE too: any already-paired but UNPLAYED set in the
// affected weeks that still references the outgoing player is moved to the incoming one
// (same contract as the console's per-set "Sub in": player swaps, reassignedFromId keeps
// the original, seed/slot stays). Played/reported/disputed sets are history -- untouched.
async function reassignUnplayedSets(seasonId: string, teamSeasonId: string, outPlayerId: string, inPlayerId: string, fromWeek: number, untilWeek: number | null) {
  const matchups = await prisma.matchup.findMany({
    where: {
      week: { seasonId, number: { gte: fromWeek, ...(untilWeek != null ? { lte: untilWeek } : {}) } },
      OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }],
    },
    select: {
      id: true,
      teamSeasonAId: true,
      week: { select: { number: true } },
      sets: { select: { id: true, playerAId: true, playerBId: true, status: true, reassignedFromId: true } },
    },
  });
  let reassigned = 0;
  const weeks: number[] = [];
  for (const mu of matchups) {
    const side = mu.teamSeasonAId === teamSeasonId ? "A" : "B";
    // Skip if the incoming player already has a set in this matchup (can't play twice).
    const already = mu.sets.some((s) => (side === "A" ? s.playerAId : s.playerBId) === inPlayerId);
    for (const s of mu.sets) {
      const cur = side === "A" ? s.playerAId : s.playerBId;
      if (cur !== outPlayerId) continue;
      if (s.status !== "PROPOSED" && s.status !== "SCHEDULED") continue; // played/disputed = history
      if (already) continue;
      await prisma.tourSet.update({
        where: { id: s.id },
        data: {
          ...(side === "A" ? { playerAId: inPlayerId } : { playerBId: inPlayerId }),
          reassignedFromId: s.reassignedFromId ?? outPlayerId, // keep the FIRST original
        },
      });
      reassigned++;
      if (!weeks.includes(mu.week.number)) weeks.push(mu.week.number);
      await notifyLive(`matchup:${mu.id}`);
    }
  }
  return { reassigned, weeks: weeks.sort((a, b) => a - b) };
}

export async function substitute(seasonName: string, teamSeasonId: string, outPlayerId: string, inPlayerId: string, effectiveWeek: number, untilWeek: number | null, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!outPlayerId || !inPlayerId) throw new Error("Pick the player going out and the player coming in.");
  if (outPlayerId === inPlayerId) throw new Error("Pick two different players.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week the sub starts.");
  if (untilWeek != null && untilWeek < effectiveWeek) throw new Error("'Until' week can't be before the start week.");
  const seed = await seedOfMember(teamSeasonId, outPlayerId);
  await ensureMembership(teamSeasonId, inPlayerId, seed); // attribution: the sub's sets count for this team
  await prisma.rosterMove.create({
    data: { seasonId, teamSeasonId, kind: "SUB", playerId: inPlayerId, outPlayerId, effectiveWeek, untilWeek, seed, reason: reason.trim(), createdBy: by },
  });
  // The lineup change propagates to the schedule: their unplayed sets in the window move too.
  const sets = await reassignUnplayedSets(seasonId, teamSeasonId, outPlayerId, inPlayerId, effectiveWeek, untilWeek ?? effectiveWeek);
  await queueRoleSync(seasonName);
  return { ok: true, ...sets };
}

export async function recordDeparture(kind: "QUIT" | "BANNED", seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  await prisma.rosterMove.create({ data: { seasonId, teamSeasonId, kind, playerId, effectiveWeek, reason: reason.trim(), createdBy: by } });
  await queueRoleSync(seasonName);
  return { ok: true };
}

export async function reinstate(seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  await prisma.rosterMove.create({ data: { seasonId, teamSeasonId, kind: "REINSTATED", playerId, effectiveWeek, reason: reason.trim() || "reinstated", createdBy: by } });
  await queueRoleSync(seasonName);
  return { ok: true };
}

// Permanent replacement: a new player fills a (typically departed) slot from a week.
// "For the rest of the season" lives HERE (an ADDED arrival), not in Substitute (windowed).
export async function replacePlayer(seasonName: string, teamSeasonId: string, inPlayerId: string, replacesPlayerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!inPlayerId) throw new Error("Pick the incoming player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week they join.");
  const seed = replacesPlayerId ? await seedOfMember(teamSeasonId, replacesPlayerId) : 99;
  await ensureMembership(teamSeasonId, inPlayerId, seed);
  await prisma.rosterMove.create({
    data: { seasonId, teamSeasonId, kind: "ADDED", playerId: inPlayerId, replacesPlayerId: replacesPlayerId || null, effectiveWeek, seed, reason: reason.trim(), createdBy: by },
  });
  // Permanent replacement -> every unplayed set of the replaced player from this week on
  // moves to the newcomer (played sets are history).
  const sets = replacesPlayerId
    ? await reassignUnplayedSets(seasonId, teamSeasonId, replacesPlayerId, inPlayerId, effectiveWeek, null)
    : { reassigned: 0, weeks: [] as number[] };
  await queueRoleSync(seasonName);
  return { ok: true, ...sets };
}

// Sub-only memberships for a set of teams: players with SUB stints but NO permanent
// arrival (DRAFTED/ADDED) on that teamSeason. Set-row displays use this to render a
// "sub" chip instead of the stored seed snapshot -- subs hold no seed, anywhere.
// Keys are `${teamSeasonId}|${playerId}`.
export async function subOnlyKeySet(teamSeasonIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(teamSeasonIds)].filter(Boolean);
  if (!ids.length) return new Set();
  const moves = await prisma.rosterMove.findMany({
    where: { teamSeasonId: { in: ids }, kind: { in: ["DRAFTED", "ADDED", "SUB"] } },
    select: { teamSeasonId: true, playerId: true, kind: true },
  });
  const arrivals = new Set(moves.filter((m) => m.kind !== "SUB").map((m) => `${m.teamSeasonId}|${m.playerId}`));
  return new Set(moves.filter((m) => m.kind === "SUB").map((m) => `${m.teamSeasonId}|${m.playerId}`).filter((k) => !arrivals.has(k)));
}

// The weeks a player actually played sets for a team -- flat imported sets carry week
// directly; live sets get it from their matchup. Lets membership fixes show the TO the
// real coverage window instead of making them guess.
async function playedWeeksOf(teamSeasonId: string, playerId: string): Promise<number[]> {
  const sets = await prisma.tourSet.findMany({
    where: {
      OR: [
        { teamSeasonAId: teamSeasonId, playerAId: playerId },
        { teamSeasonBId: teamSeasonId, playerBId: playerId },
        { matchup: { teamSeasonAId: teamSeasonId }, playerAId: playerId },
        { matchup: { teamSeasonBId: teamSeasonId }, playerBId: playerId },
      ],
    },
    select: { week: true, matchup: { select: { week: { select: { number: true } } } } },
  });
  return [...new Set(sets.map((s) => s.week ?? s.matchup?.week.number).filter((w): w is number => w != null))].sort((a, b) => a - b);
}

// Fix a mis-imported membership: the player was recorded as a PERMANENT member (a
// DRAFTED/ADDED arrival -- e.g. the import promoted a sub to a week-1 seed-12 slot)
// but was actually a temporary fill-in. Rewrites the arrival into a SUB move covering
// [effectiveWeek, untilWeek]. Their RosterEntry (stat attribution) stays -- played sets
// still credit this team; they just stop holding a permanent lineup slot.
export async function convertMemberToSub(seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, untilWeek: number | null, outPlayerId: string | null, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week their fill-in starts.");
  if (untilWeek != null && untilWeek < effectiveWeek) throw new Error("'Until' week can't be before the start week.");
  // Convert a permanent arrival OR adjust an existing sub stint (re-running with a new
  // window replaces the old one -- no dead end when the first window was wrong).
  const rewritable = await prisma.rosterMove.findMany({
    where: { teamSeasonId, playerId, kind: { in: ["DRAFTED", "ADDED", "SUB"] } },
    select: { id: true, kind: true, seed: true },
  });
  if (!rewritable.length) throw new Error("That player has no membership on this team -- nothing to convert.");
  const priorSubSeed = rewritable.find((m) => m.kind === "SUB")?.seed;
  const seed = outPlayerId
    ? await seedOfMember(teamSeasonId, outPlayerId)
    : rewritable.some((m) => m.kind !== "SUB")
      ? await seedOfMember(teamSeasonId, playerId)
      : priorSubSeed ?? 99;
  await prisma.rosterMove.deleteMany({ where: { id: { in: rewritable.map((a) => a.id) } } });
  await prisma.rosterMove.create({
    data: {
      seasonId, teamSeasonId, kind: "SUB", playerId,
      outPlayerId: outPlayerId || null, effectiveWeek, untilWeek, seed,
      reason: reason.trim() || "membership fix: imported as permanent, actually a sub",
      createdBy: by,
    },
  });
  await queueRoleSync(seasonName);
  const playedWeeks = await playedWeeksOf(teamSeasonId, playerId);
  const outside = playedWeeks.filter((w) => w < effectiveWeek || (untilWeek != null && w > untilWeek));
  return { playedWeeks, outside };
}

// The reverse fix: a temporary SUB who is actually a permanent member. Rewrites their
// SUB move(s) into an ADDED arrival from the given week.
export async function convertSubToMember(seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, seed: number | null, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week they join for good.");
  const subs = await prisma.rosterMove.findMany({ where: { teamSeasonId, playerId, kind: "SUB" }, select: { id: true, seed: true } });
  if (!subs.length) throw new Error("That player has no sub stint on this team -- nothing to convert.");
  const useSeed = seed ?? subs[0].seed ?? 99;
  await prisma.rosterMove.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.rosterMove.create({
    data: {
      seasonId, teamSeasonId, kind: "ADDED", playerId, effectiveWeek, seed: useSeed,
      reason: reason.trim() || "membership fix: sub is actually a permanent member",
      createdBy: by,
    },
  });
  await ensureMembership(teamSeasonId, playerId, useSeed);
  await queueRoleSync(seasonName);
  return { ok: true };
}

// Escape hatch for a mis-entered move (the proper "they came back" is reinstate).
export async function removeMove(moveId: string) {
  const move = await prisma.rosterMove.findUnique({ where: { id: moveId }, select: { seasonId: true } });
  await prisma.rosterMove.delete({ where: { id: moveId } });
  if (move) {
    const season = await prisma.tourSeason.findUnique({ where: { id: move.seasonId }, select: { name: true } });
    if (season) await queueRoleSync(season.name);
  }
}

// One-time backfill: seed DRAFTED moves so seasons drafted before this model still derive
// + show their initial rosters. Sourced from RosterEntry (the canonical intra-team seed:
// captain = 1, drafted players = 2..N, unique) — NOT DraftPick.round, which omits the
// captain and would make Player 1 collide with the captain at seed 1. Idempotent.
export async function backfillDraftedMoves(): Promise<{ created: number }> {
  // DRAFTED moves are fully derived from the roster (week-1 baseline) — never hand-edited —
  // so refresh them: drop the old ones and rebuild from current RosterEntry seeds. This
  // keeps a re-import in sync without touching manual RESEED / SUB / ADDED moves.
  //
  // Skip anyone with a SUB or ADDED move on that team: RosterEntry rows exist for stat
  // attribution (ensureMembership creates one for every sub), so blindly promoting every
  // entry to a week-1 DRAFTED member turned subs into permanent seed-holders on re-import.
  await prisma.rosterMove.deleteMany({ where: { kind: "DRAFTED" } });
  const manual = await prisma.rosterMove.findMany({ where: { kind: { in: ["SUB", "ADDED"] } }, select: { teamSeasonId: true, playerId: true } });
  const skip = new Set(manual.map((m) => `${m.teamSeasonId}|${m.playerId}`));
  const rosters = await prisma.roster.findMany({
    include: { entries: { select: { playerId: true, seed: true } }, teamSeason: { select: { id: true, seasonId: true } } },
  });
  let created = 0;
  const seen = new Set<string>(); // a teamSeason may have >1 roster block; one DRAFTED per (ts, player)
  for (const r of rosters) {
    for (const e of r.entries) {
      const k = `${r.teamSeason.id}|${e.playerId}`;
      if (seen.has(k) || skip.has(k)) continue;
      seen.add(k);
      await prisma.rosterMove.create({ data: { seasonId: r.teamSeason.seasonId, teamSeasonId: r.teamSeason.id, kind: "DRAFTED", playerId: e.playerId, effectiveWeek: 1, seed: e.seed } });
      created++;
    }
  }
  return { created };
}

// Admin view: the derived lineup per team for a selected week + the free-agent pool
// + the full move timeline.
export async function getRosterOps(seasonName: string, week?: number) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true } });
  if (!season) return null;

  const [weeks, teamSeasons, moves, approved] = await Promise.all([
    prisma.week.findMany({ where: { seasonId: season.id }, select: { number: true }, orderBy: { number: "asc" } }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true, rosters: { include: { entries: true } } } }),
    prisma.rosterMove.findMany({ where: { seasonId: season.id }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] }),
    prisma.signup.findMany({ where: { seasonId: season.id, status: "APPROVED" }, select: { discordId: true } }),
  ]);

  // Navigable weeks = the schedule's weeks ∪ any week a move takes effect (so you
  // can jump to where the roster actually changed even before/without a schedule).
  const moveWeeks = moves.flatMap((m) => [m.effectiveWeek, m.untilWeek ?? m.effectiveWeek]);
  const weekNumbers = [...new Set([...weeks.map((w) => w.number), ...moveWeeks])].filter((n) => n >= 1).sort((a, b) => a - b);
  const maxWeek = weekNumbers.length ? Math.max(...weekNumbers) : 1;
  const selectedWeek = Math.max(1, week ?? maxWeek); // no upper clamp — you can view any week

  const movesByTeam = new Map<string, MoveRow[]>();
  for (const m of moves) {
    const arr = movesByTeam.get(m.teamSeasonId) ?? [];
    arr.push(m as MoveRow);
    movesByTeam.set(m.teamSeasonId, arr);
  }

  // Names + free agents.
  const rosteredIds = new Set(teamSeasons.flatMap((t) => t.rosters.flatMap((r) => r.entries.map((e) => e.playerId))));
  const approvedPlayers = await prisma.player.findMany({ where: { discordId: { in: approved.map((a) => a.discordId) } }, select: { id: true, displayName: true } });
  const freeAgents = approvedPlayers.filter((p) => !rosteredIds.has(p.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const allPlayerIds = [
    ...rosteredIds,
    ...approvedPlayers.map((p) => p.id),
    ...moves.flatMap((m) => [m.playerId, m.outPlayerId, m.replacesPlayerId]).filter((x): x is string => !!x),
    ...teamSeasons.map((t) => t.captainPlayerId),
  ];
  const players = await prisma.player.findMany({ where: { id: { in: [...new Set(allPlayerIds)] } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const teamNameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));

  const teams = teamSeasons.map((t) => {
    const coCaptains = new Set(t.rosters.flatMap((r) => r.entries.filter((e) => e.isCoCaptain).map((e) => e.playerId)));
    const tMoves = movesByTeam.get(t.id) ?? [];
    const captainNow = captainAtWeek(tMoves, selectedWeek, t.captainPlayerId);
    const lineup = deriveLineup(tMoves, selectedWeek, captainNow);
    const activeIds = new Set(lineup.map((p) => p.playerId));

    // FULL season membership -- the team is a SEASON-long thing; the week selector only
    // decides who's highlighted as active. Fold the move log per player: permanent
    // arrival (+ latest seed), departure state, and any sub stints.
    interface Mem { playerId: string; seed: number | null; joinedWeek: number | null; stints: string[]; activeStint: boolean; departed: { kind: string; week: number } | null }
    const mem = new Map<string, Mem>();
    const getM = (pid: string): Mem => {
      let m = mem.get(pid);
      if (!m) { m = { playerId: pid, seed: null, joinedWeek: null, stints: [], activeStint: false, departed: null }; mem.set(pid, m); }
      return m;
    };
    const ordered = [...tMoves].sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt);
    for (const m of ordered) {
      const r = getM(m.playerId);
      if (m.kind === "DRAFTED" || m.kind === "ADDED") {
        if (r.joinedWeek == null || m.effectiveWeek < r.joinedWeek) { r.joinedWeek = m.effectiveWeek; r.seed = r.seed ?? m.seed ?? null; }
      } else if (m.kind === "RESEED" && m.seed != null) r.seed = m.seed;
      else if (m.kind === "QUIT" || m.kind === "BANNED") r.departed = { kind: m.kind, week: m.effectiveWeek };
      else if (m.kind === "REINSTATED") r.departed = null;
      else if (m.kind === "SUB") {
        r.stints.push(m.untilWeek != null && m.untilWeek !== m.effectiveWeek ? `W${m.effectiveWeek}-${m.untilWeek}` : `W${m.effectiveWeek}`);
        if (m.effectiveWeek <= selectedWeek && selectedWeek <= (m.untilWeek ?? m.effectiveWeek)) r.activeStint = true;
      }
    }
    const membership = [...mem.values()]
      .map((r) => ({
        playerId: r.playerId,
        name: nameOf.get(r.playerId) ?? r.playerId,
        seed: r.joinedWeek != null ? r.seed : null, // subs never hold a seed
        isMember: r.joinedWeek != null,
        joinedWeek: r.joinedWeek,
        stints: r.stints,
        departed: r.departed,
        isCaptain: r.playerId === captainNow,
        isCoCaptain: coCaptains.has(r.playerId),
        activeNow: activeIds.has(r.playerId),
      }))
      // Members by seed, subs after, departed where they fall (dimmed by the UI).
      .sort((a, b) => Number(!a.isMember) - Number(!b.isMember) || (a.seed ?? 99) - (b.seed ?? 99) || a.name.localeCompare(b.name));

    return {
      teamSeasonId: t.id,
      name: t.team.name,
      captainPlayerId: captainNow,
      membership,
      lineup: lineup.map((p) => ({
        playerId: p.playerId,
        name: nameOf.get(p.playerId) ?? p.playerId,
        seed: p.seed,
        isCaptain: p.isCaptain,
        isCoCaptain: coCaptains.has(p.playerId),
        viaSub: p.viaSub,
      })),
      // Sub stints (kept for the Fix-membership selects).
      subStints: tMoves
        .filter((m) => m.kind === "SUB")
        .map((m) => ({
          playerId: m.playerId,
          name: nameOf.get(m.playerId) ?? m.playerId,
          window: m.untilWeek != null && m.untilWeek !== m.effectiveWeek ? `W${m.effectiveWeek}-${m.untilWeek}` : `W${m.effectiveWeek}`,
          activeNow: m.effectiveWeek <= selectedWeek && selectedWeek <= (m.untilWeek ?? m.effectiveWeek),
        })),
    };
  });

  // Strikes (TO aid): per-player season + career counts + the season log -- across the
  // whole membership (dimmed rows included), not just the selected week's lineups.
  const lineupIds = [...new Set(teams.flatMap((t) => t.membership.map((p) => p.playerId)))];
  const [seasonStrikes, careerStrikes, strikeLog] = await Promise.all([
    getSeasonStrikeCounts(season.id),
    getCareerStrikeCounts(lineupIds),
    getSeasonStrikeLog(season.id),
  ]);
  const strikeOf: Record<string, { season: number; career: number; atRisk: boolean }> = {};
  for (const id of lineupIds) {
    const career = careerStrikes.get(id) ?? 0;
    strikeOf[id] = { season: seasonStrikes.get(id) ?? 0, career, atRisk: career >= AT_RISK_THRESHOLD };
  }

  const timeline = [...moves]
    .sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      kindLabel: KIND_LABEL[m.kind] ?? m.kind,
      week: m.effectiveWeek,
      untilWeek: m.untilWeek,
      seed: m.seed,
      teamSeasonId: m.teamSeasonId,
      playerId: m.playerId,
      team: teamNameOf.get(m.teamSeasonId) ?? null,
      player: nameOf.get(m.playerId) ?? m.playerId,
      outPlayer: m.outPlayerId ? nameOf.get(m.outPlayerId) ?? m.outPlayerId : null,
      replaces: m.replacesPlayerId ? nameOf.get(m.replacesPlayerId) ?? m.replacesPlayerId : null,
      reason: m.reason,
      createdBy: m.createdBy,
    }));

  return {
    seasonName: season.name,
    weeks: weekNumbers,
    maxWeek,
    selectedWeek,
    teams,
    freeAgents: freeAgents.map((p) => ({ id: p.id, name: p.displayName })),
    timeline,
    strikeOf,
    strikeLog,
  };
}
