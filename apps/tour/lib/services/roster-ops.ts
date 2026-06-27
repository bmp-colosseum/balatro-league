// Weekly roster model (§B7). The lineup for any week is DERIVED by folding an
// append-only RosterMove log — never stored, never deleted, so history is total
// and the log itself is the timeline. Stat ATTRIBUTION (which team a player is on
// for the season) stays in RosterEntry, which is left untouched; this layer is
// purely lineup-over-time. One team per season, so a player is on at most one team.
import { prisma } from "../db";

export const KIND_LABEL: Record<string, string> = {
  DRAFTED: "Drafted",
  ADDED: "Added",
  SUB: "Sub",
  QUIT: "Quit",
  BANNED: "Banned",
  REINSTATED: "Reinstated",
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
  for (const m of [...moves].sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)) {
    if (m.effectiveWeek > week) continue;
    if (m.kind === "QUIT" || m.kind === "BANNED") gone.set(m.playerId, true);
    else if (m.kind === "REINSTATED") gone.set(m.playerId, false);
  }

  const lineup = new Map<string, LineupPlayer>();
  for (const [pid, js] of joinSeed) {
    if (js.week <= week && !gone.get(pid)) lineup.set(pid, { playerId: pid, seed: js.seed, isCaptain: pid === captainId, viaSub: false });
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

// The derived lineup for one team in one week (used by the pairing tool).
export async function rosterForWeek(teamSeasonId: string, week: number): Promise<LineupPlayer[]> {
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, select: { captainPlayerId: true } });
  if (!ts) return [];
  const moves = await prisma.rosterMove.findMany({ where: { teamSeasonId }, orderBy: [{ effectiveWeek: "asc" }, { createdAt: "asc" }] });
  return deriveLineup(moves, week, ts.captainPlayerId);
}

// ── Membership (stat attribution) — add a player to the team's roster so their
// sets attribute. RosterEntry is the season membership; never removed on departure.
async function ensureMembership(teamSeasonId: string, playerId: string, seed: number) {
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
  return { ok: true };
}

export async function recordDeparture(kind: "QUIT" | "BANNED", seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  await prisma.rosterMove.create({ data: { seasonId, teamSeasonId, kind, playerId, effectiveWeek, reason: reason.trim(), createdBy: by } });
  return { ok: true };
}

export async function reinstate(seasonName: string, teamSeasonId: string, playerId: string, effectiveWeek: number, reason: string, by?: string) {
  const seasonId = await seasonIdOf(seasonName);
  if (!playerId) throw new Error("Pick the player.");
  if (!effectiveWeek || effectiveWeek < 1) throw new Error("Pick the week it takes effect.");
  await prisma.rosterMove.create({ data: { seasonId, teamSeasonId, kind: "REINSTATED", playerId, effectiveWeek, reason: reason.trim() || "reinstated", createdBy: by } });
  return { ok: true };
}

// Permanent replacement: a new player fills a (typically departed) slot from a week.
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
  return { ok: true };
}

// Escape hatch for a mis-entered move (the proper "they came back" is reinstate).
export async function removeMove(moveId: string) {
  await prisma.rosterMove.delete({ where: { id: moveId } });
}

// One-time backfill: turn existing draft picks into DRAFTED moves so seasons drafted
// before this model still derive + show their initial rosters. Idempotent.
export async function backfillDraftedMoves(): Promise<{ created: number }> {
  const drafts = await prisma.draft.findMany({ include: { picks: { where: { NOT: { playerId: null } } } } });
  let created = 0;
  for (const d of drafts) {
    for (const p of d.picks) {
      const exists = await prisma.rosterMove.findFirst({ where: { teamSeasonId: p.teamSeasonId, playerId: p.playerId!, kind: "DRAFTED" } });
      if (exists) continue;
      await prisma.rosterMove.create({ data: { seasonId: d.seasonId, teamSeasonId: p.teamSeasonId, kind: "DRAFTED", playerId: p.playerId!, effectiveWeek: 1, seed: p.round } });
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

  const teams = teamSeasons.map((t) => ({
    teamSeasonId: t.id,
    name: t.team.name,
    captainPlayerId: t.captainPlayerId,
    lineup: deriveLineup(movesByTeam.get(t.id) ?? [], selectedWeek, t.captainPlayerId).map((p) => ({
      playerId: p.playerId,
      name: nameOf.get(p.playerId) ?? p.playerId,
      seed: p.seed,
      isCaptain: p.isCaptain,
      viaSub: p.viaSub,
    })),
  }));

  const timeline = [...moves]
    .sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      kindLabel: KIND_LABEL[m.kind] ?? m.kind,
      week: m.effectiveWeek,
      untilWeek: m.untilWeek,
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
  };
}
