// Roster change requests — the captain-initiated approval queue.
//
// Captains don't mutate the roster directly. Their ops land here as PENDING
// RosterChangeRequest rows; a mod (TO or ROSTERS grant) approves -> the matching
// roster-ops service fn runs (appending the real RosterMove) -> the request is
// marked APPROVED. Mods themselves never touch this layer; they apply directly.
//
// Services stay auth-agnostic: the CALLER decides mod-vs-captain and routes here
// or straight to roster-ops. This module just persists, enriches, and dispatches.
import { prisma } from "../db";
import {
  substitute,
  recordDeparture,
  replacePlayer,
  reseed,
  swapSeeds,
  changeCaptain,
  setCoCaptain,
  reinstate,
} from "./roster-ops";

export type RosterRequestKind =
  | "SUB"
  | "QUIT"
  | "BANNED"
  | "REPLACE"
  | "RESEED"
  | "SWAP"
  | "CAPTAIN_CHANGE"
  | "CO_CAPTAIN"
  | "REINSTATE";

const KIND_LABEL: Record<RosterRequestKind, string> = {
  SUB: "Substitute",
  QUIT: "Quit",
  BANNED: "Ban",
  REPLACE: "Replace",
  RESEED: "Re-seed",
  SWAP: "Swap seeds",
  CAPTAIN_CHANGE: "Captain change",
  CO_CAPTAIN: "Co-captain",
  REINSTATE: "Reinstate",
};

export type RosterRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
// Rejecting one of these needs a written reason -- they're high-impact and the captain
// who filed it deserves to know why.
const HIGH_IMPACT = new Set<RosterRequestKind>(["QUIT", "BANNED", "CAPTAIN_CHANGE"]);

// The op payload a captain submits (superset of roster-ops args; only the fields a
// given kind needs are set). Season/team/requester are supplied by createRosterRequest.
export interface RosterRequestPayload {
  kind: RosterRequestKind;
  playerId: string;
  outPlayerId?: string | null;
  replacesPlayerId?: string | null;
  playerBId?: string | null;
  effectiveWeek: number;
  untilWeek?: number | null;
  seed?: number | null;
  isCoCaptain?: boolean | null;
  reason?: string | null;
}

export interface CreateRosterRequestInput extends RosterRequestPayload {
  seasonName: string;
  teamSeasonId: string;
  requestedBy: string; // captain discord id
  requestedName?: string | null;
}

// A pending request enriched with display names + a one-line human summary.
export interface RosterRequestView {
  id: string;
  seasonId: string;
  teamSeasonId: string;
  teamName: string;
  kind: RosterRequestKind;
  kindLabel: string;
  playerId: string;
  playerName: string;
  outPlayerId: string | null;
  outPlayerName: string | null;
  replacesPlayerId: string | null;
  replacesPlayerName: string | null;
  playerBId: string | null;
  playerBName: string | null;
  effectiveWeek: number;
  untilWeek: number | null;
  seed: number | null;
  isCoCaptain: boolean | null;
  reason: string | null;
  requestedBy: string;
  requestedName: string | null;
  createdAt: Date;
  status: RosterRequestStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  summary: string;
}

async function seasonName(seasonId: string): Promise<string> {
  const s = await prisma.tourSeason.findUnique({ where: { id: seasonId }, select: { name: true } });
  if (!s) throw new Error("Season not found.");
  return s.name;
}

// ── Create ────────────────────────────────────────────────────────────────
export async function createRosterRequest(input: CreateRosterRequestInput): Promise<{ ok: true; id: string }> {
  const seasonId = await prisma.tourSeason.findUnique({ where: { name: input.seasonName }, select: { id: true } });
  if (!seasonId) throw new Error("Season not found.");
  if (!input.teamSeasonId) throw new Error("Missing team.");
  if (!input.playerId) throw new Error("Pick a player.");
  if (!input.requestedBy) throw new Error("Link your Discord before requesting roster changes.");
  const r = await prisma.rosterChangeRequest.create({
    data: {
      seasonId: seasonId.id,
      teamSeasonId: input.teamSeasonId,
      kind: input.kind,
      playerId: input.playerId,
      outPlayerId: input.outPlayerId ?? null,
      replacesPlayerId: input.replacesPlayerId ?? null,
      playerBId: input.playerBId ?? null,
      effectiveWeek: input.effectiveWeek,
      untilWeek: input.untilWeek ?? null,
      seed: input.seed ?? null,
      isCoCaptain: input.isCoCaptain ?? null,
      reason: input.reason?.trim() || null,
      requestedBy: input.requestedBy,
      requestedName: input.requestedName ?? null,
    },
    select: { id: true },
  });
  return { ok: true, id: r.id };
}

// ── Reads ─────────────────────────────────────────────────────────────────
interface RawRequest {
  id: string;
  seasonId: string;
  teamSeasonId: string;
  kind: RosterRequestKind;
  playerId: string;
  outPlayerId: string | null;
  replacesPlayerId: string | null;
  playerBId: string | null;
  effectiveWeek: number;
  untilWeek: number | null;
  seed: number | null;
  isCoCaptain: boolean | null;
  reason: string | null;
  requestedBy: string;
  requestedName: string | null;
  createdAt: Date;
  status: RosterRequestStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
}

function weekLabel(from: number, until: number | null): string {
  return until && until !== from ? `W${from}-${until}` : `W${from}`;
}

function summarize(r: RawRequest, name: (id: string | null) => string | null): string {
  const p = name(r.playerId) ?? "player";
  const wk = weekLabel(r.effectiveWeek, r.untilWeek);
  switch (r.kind) {
    case "SUB":
      return `${name(r.outPlayerId) ?? "someone"} out, ${p} in (${wk})`;
    case "QUIT":
      return `${p} quits (from W${r.effectiveWeek})`;
    case "BANNED":
      return `${p} banned (from W${r.effectiveWeek})`;
    case "REPLACE":
      return `${p} fills ${name(r.replacesPlayerId) ?? "a departed slot"} (W${r.effectiveWeek})`;
    case "RESEED":
      return `${p} to seed ${r.seed ?? "?"} (W${r.effectiveWeek})`;
    case "SWAP":
      return `${p} <-> ${name(r.playerBId) ?? "player"} seeds (W${r.effectiveWeek})`;
    case "CAPTAIN_CHANGE":
      return `${p} becomes captain (W${r.effectiveWeek})`;
    case "CO_CAPTAIN":
      return `${r.isCoCaptain ? "add" : "remove"} ${p} as co-captain`;
    case "REINSTATE":
      return `reinstate ${p} (W${r.effectiveWeek})`;
  }
}

async function enrich(rows: RawRequest[]): Promise<RosterRequestView[]> {
  if (rows.length === 0) return [];
  const playerIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const r of rows) {
    teamIds.add(r.teamSeasonId);
    for (const id of [r.playerId, r.outPlayerId, r.replacesPlayerId, r.playerBId]) if (id) playerIds.add(id);
  }
  const [players, teams] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, displayName: true } }),
    prisma.teamSeason.findMany({ where: { id: { in: [...teamIds] } }, select: { id: true, team: { select: { name: true } } } }),
  ]);
  const pName = new Map(players.map((p) => [p.id, p.displayName]));
  const tName = new Map(teams.map((t) => [t.id, t.team.name]));
  const nameOf = (id: string | null) => (id ? pName.get(id) ?? null : null);
  return rows.map((r) => ({
    ...r,
    teamName: tName.get(r.teamSeasonId) ?? "team",
    kindLabel: KIND_LABEL[r.kind],
    playerName: nameOf(r.playerId) ?? "player",
    outPlayerName: nameOf(r.outPlayerId),
    replacesPlayerName: nameOf(r.replacesPlayerId),
    playerBName: nameOf(r.playerBId),
    summary: summarize(r, nameOf),
  }));
}

// Pending requests across a whole season (the mod inbox).
export async function listPendingRequests(seasonNameOrId: string, byId = false): Promise<RosterRequestView[]> {
  const seasonId = byId
    ? seasonNameOrId
    : (await prisma.tourSeason.findUnique({ where: { name: seasonNameOrId }, select: { id: true } }))?.id;
  if (!seasonId) return [];
  const rows = await prisma.rosterChangeRequest.findMany({
    where: { seasonId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  return enrich(rows as RawRequest[]);
}

// Pending requests for one team (rendered inline in TeamManagePanel).
export async function pendingRequestsForTeam(teamSeasonId: string): Promise<RosterRequestView[]> {
  const rows = await prisma.rosterChangeRequest.findMany({
    where: { teamSeasonId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  return enrich(rows as RawRequest[]);
}

// teamSeasonId -> pending count, for markers + the hub tile.
export async function pendingCountsByTeam(seasonId: string): Promise<Map<string, number>> {
  const grouped = await prisma.rosterChangeRequest.groupBy({
    by: ["teamSeasonId"],
    where: { seasonId, status: "PENDING" },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.teamSeasonId, g._count._all]));
}

export async function pendingRequestCount(seasonId: string): Promise<number> {
  return prisma.rosterChangeRequest.count({ where: { seasonId, status: "PENDING" } });
}

// ── Decisions ───────────────────────────────────────────────────────────────
// Run the underlying roster op, attributing the applied move to the deciding mod.
async function apply(r: RawRequest, season: string, by: string): Promise<void> {
  const reason = r.reason ?? "";
  switch (r.kind) {
    case "SUB":
      await substitute(season, r.teamSeasonId, r.outPlayerId ?? "", r.playerId, r.effectiveWeek, r.untilWeek ?? null, reason, by);
      return;
    case "QUIT":
      await recordDeparture("QUIT", season, r.teamSeasonId, r.playerId, r.effectiveWeek, reason, by);
      return;
    case "BANNED":
      await recordDeparture("BANNED", season, r.teamSeasonId, r.playerId, r.effectiveWeek, reason, by);
      return;
    case "REPLACE":
      await replacePlayer(season, r.teamSeasonId, r.playerId, r.replacesPlayerId ?? "", r.effectiveWeek, reason, by);
      return;
    case "RESEED":
      await reseed(season, r.teamSeasonId, r.playerId, r.seed ?? 0, r.effectiveWeek, reason, by);
      return;
    case "SWAP":
      await swapSeeds(season, r.teamSeasonId, r.playerId, r.playerBId ?? "", r.effectiveWeek, reason, by);
      return;
    case "CAPTAIN_CHANGE":
      await changeCaptain(season, r.teamSeasonId, r.playerId, r.effectiveWeek, reason, by);
      return;
    case "CO_CAPTAIN":
      await setCoCaptain(r.teamSeasonId, r.playerId, !!r.isCoCaptain);
      return;
    case "REINSTATE":
      await reinstate(season, r.teamSeasonId, r.playerId, r.effectiveWeek, reason, by);
      return;
  }
}

// Approve: run the op, then mark APPROVED. If the op throws, the request stays
// PENDING (nothing is marked) so the mod can see it failed and retry/reject.
export async function approveRosterRequest(id: string, decidedBy: string): Promise<{ ok: true; summary: string }> {
  const r = (await prisma.rosterChangeRequest.findUnique({ where: { id } })) as RawRequest & { status: string } | null;
  if (!r) throw new Error("Request not found.");
  if (r.status !== "PENDING") throw new Error("This request was already handled.");
  const season = await seasonName(r.seasonId);
  await apply(r, season, decidedBy);
  await prisma.rosterChangeRequest.update({ where: { id }, data: { status: "APPROVED", decidedBy, decidedAt: new Date() } });
  const [view] = await enrich([r]);
  return { ok: true, summary: view?.summary ?? "request" };
}

export async function rejectRosterRequest(id: string, decidedBy: string, note?: string | null): Promise<{ ok: true }> {
  const r = await prisma.rosterChangeRequest.findUnique({ where: { id }, select: { status: true, kind: true } });
  if (!r) throw new Error("Request not found.");
  if (r.status !== "PENDING") throw new Error("This request was already handled.");
  if (HIGH_IMPACT.has(r.kind as RosterRequestKind) && !note?.trim()) {
    throw new Error(`Add a note explaining why -- rejecting a ${KIND_LABEL[r.kind as RosterRequestKind].toLowerCase()} needs a reason for the captain.`);
  }
  await prisma.rosterChangeRequest.update({
    where: { id },
    data: { status: "REJECTED", decidedBy, decidedAt: new Date(), decisionNote: note?.trim() || null },
  });
  return { ok: true };
}

// A captain's own recent requests (any status) -- the round-trip so they see the outcome.
export async function myRecentRequests(discordId: string | null, limit = 10): Promise<RosterRequestView[]> {
  if (!discordId) return [];
  const rows = await prisma.rosterChangeRequest.findMany({
    where: { requestedBy: discordId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return enrich(rows as RawRequest[]);
}

// Approve a batch (the inbox bulk bar). Each runs independently; one failure doesn't block the rest.
export async function approveManyRosterRequests(ids: string[], decidedBy: string): Promise<{ approved: number; failed: { id: string; error: string }[] }> {
  let approved = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await approveRosterRequest(id, decidedBy);
      approved++;
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return { approved, failed };
}

// Cancel: the requesting captain (or a mod) withdraws a still-pending request.
export async function cancelRosterRequest(id: string, by: string): Promise<{ ok: true; teamSeasonId: string }> {
  const r = await prisma.rosterChangeRequest.findUnique({ where: { id }, select: { status: true, teamSeasonId: true } });
  if (!r) throw new Error("Request not found.");
  if (r.status !== "PENDING") throw new Error("This request was already handled.");
  await prisma.rosterChangeRequest.update({ where: { id }, data: { status: "CANCELLED", decidedBy: by, decidedAt: new Date() } });
  return { ok: true, teamSeasonId: r.teamSeasonId };
}
