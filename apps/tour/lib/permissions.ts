// Fine-grained capabilities layered on top of the tier system (lib/auth.ts). OWNER/TO always
// have every capability. Non-TOs get capabilities from ModGrant rows (granted to their Discord
// USER id or a ROLE they hold), optionally season-scoped. Captains additionally get team-scoped
// ROSTERS/DRAFT/SCHEDULE for the teams they captain (data-derived from TeamSeason.captainPlayerId).
//
// Services stay auth-agnostic; the CALLER (action/route/page) gates — same convention as isAdmin.
import { prisma } from "./db";
import { getViewer, type Viewer } from "./auth";

export type Capability = "NEWS" | "RANKINGS" | "ROSTERS" | "DRAFT" | "SCHEDULE";
export const CAPABILITIES: Capability[] = ["NEWS", "RANKINGS", "ROSTERS", "DRAFT", "SCHEDULE"];
// Capabilities a captain holds for their own team (not the content caps).
const TEAM_SCOPED: readonly Capability[] = ["ROSTERS", "DRAFT", "SCHEDULE"];

export interface CanContext {
  seasonId?: string | null;
  teamSeasonId?: string | string[] | null; // a captain passes for team(s) they captain
}

const isTO = (v: Viewer) => v.tier === "OWNER" || v.tier === "TO";

// Season name → id (grants + captain scoping key on the id). null when the season is unknown.
export async function seasonIdByName(name: string): Promise<string | null> {
  const s = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  return s?.id ?? null;
}

// The season + both teams of a matchup / playoff series — the scope for SCHEDULE checks
// (either team's captain, a SCHEDULE mod, or a TO may act).
export async function matchupScope(matchupId: string): Promise<{ seasonId: string | null; teamSeasonIds: string[] }> {
  const mu = await prisma.matchup.findUnique({ where: { id: matchupId }, select: { teamSeasonAId: true, teamSeasonBId: true, weekId: true } });
  if (!mu) return { seasonId: null, teamSeasonIds: [] };
  const wk = await prisma.week.findUnique({ where: { id: mu.weekId }, select: { seasonId: true } });
  return { seasonId: wk?.seasonId ?? null, teamSeasonIds: [mu.teamSeasonAId, mu.teamSeasonBId] };
}

export async function seriesScope(seriesId: string): Promise<{ seasonId: string | null; teamSeasonIds: string[] }> {
  const s = await prisma.playoffSeries.findUnique({ where: { id: seriesId }, select: { seasonId: true, teamSeasonAId: true, teamSeasonBId: true } });
  if (!s) return { seasonId: null, teamSeasonIds: [] };
  return { seasonId: s.seasonId, teamSeasonIds: [s.teamSeasonAId, s.teamSeasonBId].filter((x): x is string => !!x) };
}

// All capabilities a viewer holds (globally or for the given season) — NOT counting the
// team-scoped captain grants, which depend on the resource (see canFor).
export async function capabilitiesFor(v: Viewer, seasonId?: string | null): Promise<Set<Capability>> {
  if (isTO(v)) return new Set(CAPABILITIES);
  const subjects: { subjectType: "USER" | "ROLE"; subjectId: string }[] = [];
  if (v.discordId) subjects.push({ subjectType: "USER", subjectId: v.discordId });
  for (const r of v.roleIds) subjects.push({ subjectType: "ROLE", subjectId: r });
  if (!subjects.length) return new Set();
  const grants = await prisma.modGrant.findMany({ where: { OR: subjects }, select: { capability: true, seasonId: true } });
  // A grant applies if it's global (seasonId null) or matches the requested season.
  const out = new Set<Capability>();
  for (const g of grants) {
    if (seasonId === undefined || g.seasonId === null || g.seasonId === seasonId) out.add(g.capability as Capability);
  }
  return out;
}

// The teamSeason ids a viewer captains (optionally within a season).
export async function captainTeamsFor(v: Viewer, seasonId?: string | null): Promise<Set<string>> {
  if (!v.playerId) return new Set();
  const teams = await prisma.teamSeason.findMany({
    where: { captainPlayerId: v.playerId, ...(seasonId ? { seasonId } : {}) },
    select: { id: true },
  });
  return new Set(teams.map((t) => t.id));
}

// Resource-aware capability check for an already-loaded viewer.
export async function canFor(v: Viewer, capability: Capability, ctx: CanContext = {}): Promise<boolean> {
  if (isTO(v)) return true;
  const caps = await capabilitiesFor(v, ctx.seasonId);
  if (caps.has(capability)) return true;
  if (ctx.teamSeasonId && TEAM_SCOPED.includes(capability) && v.playerId) {
    const ids = Array.isArray(ctx.teamSeasonId) ? ctx.teamSeasonId : [ctx.teamSeasonId];
    const mine = await captainTeamsFor(v, ctx.seasonId);
    if (ids.some((id) => mine.has(id))) return true;
  }
  return false;
}

// Convenience: check for the current viewer.
export async function can(capability: Capability, ctx: CanContext = {}): Promise<boolean> {
  return canFor(await getViewer(), capability, ctx);
}

export async function assertCan(capability: Capability, ctx: CanContext = {}): Promise<void> {
  if (!(await can(capability, ctx))) throw new Error("Forbidden: you don't have permission for this.");
}

// May the viewer reach the /admin shell at all? TO, any capability grant, or captaincy.
export async function hasAnyAccess(v: Viewer): Promise<boolean> {
  if (isTO(v)) return true;
  if ((await capabilitiesFor(v)).size > 0) return true;
  return (await captainTeamsFor(v)).size > 0;
}
