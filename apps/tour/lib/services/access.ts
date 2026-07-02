// Access management — list / grant / revoke ModGrants (a capability given to a Discord user or
// role, optionally season-scoped), plus a read-only roles overview (captains per season). The
// /admin/access page + actions are thin callers; TO-only gating lives there.
import { prisma } from "../db";
import { CAPABILITIES, type Capability } from "../permissions";

export interface GrantView {
  id: string;
  subjectType: "USER" | "ROLE";
  subjectId: string;
  label: string | null;
  capability: Capability;
  seasonId: string | null;
  seasonName: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export async function listGrants(): Promise<GrantView[]> {
  const grants = await prisma.modGrant.findMany({ orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }, { capability: "asc" }] });
  const seasonIds = [...new Set(grants.map((g) => g.seasonId).filter((x): x is string => !!x))];
  const seasons = seasonIds.length ? await prisma.tourSeason.findMany({ where: { id: { in: seasonIds } }, select: { id: true, name: true } }) : [];
  const sName = new Map(seasons.map((s) => [s.id, s.name]));
  return grants.map((g) => ({
    id: g.id,
    subjectType: g.subjectType as "USER" | "ROLE",
    subjectId: g.subjectId,
    label: g.label,
    capability: g.capability as Capability,
    seasonId: g.seasonId,
    seasonName: g.seasonId ? sName.get(g.seasonId) ?? null : null,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
  }));
}

export async function grantCapabilities(input: {
  subjectType: "USER" | "ROLE";
  subjectId: string;
  label?: string | null;
  capabilities: Capability[];
  seasonId?: string | null;
  by?: string | null;
}): Promise<number> {
  const subjectId = input.subjectId.trim();
  if (!subjectId) throw new Error("Pick who to grant to.");
  const caps = input.capabilities.filter((c) => CAPABILITIES.includes(c));
  if (!caps.length) throw new Error("Pick at least one capability.");
  const seasonId = input.seasonId || null;
  let n = 0;
  for (const capability of caps) {
    // Nullable seasonId means the compound unique can't be used in upsert reliably (NULLs are
    // distinct in Postgres) — find-then-write instead so global grants don't duplicate.
    const existing = await prisma.modGrant.findFirst({ where: { subjectType: input.subjectType, subjectId, capability, seasonId } });
    if (existing) {
      await prisma.modGrant.update({ where: { id: existing.id }, data: { label: input.label ?? existing.label } });
    } else {
      await prisma.modGrant.create({ data: { subjectType: input.subjectType, subjectId, capability, seasonId, label: input.label ?? null, createdBy: input.by ?? null } });
      n++;
    }
  }
  return n;
}

export async function revokeGrant(id: string): Promise<void> {
  await prisma.modGrant.delete({ where: { id } });
}

// A real (non-legacy) Discord user to grant to.
export async function grantablePlayers(): Promise<{ discordId: string; name: string }[]> {
  const players = await prisma.player.findMany({ where: { NOT: { discordId: { startsWith: "legacy:" } } }, select: { discordId: true, displayName: true } });
  return players.map((p) => ({ discordId: p.discordId, name: p.displayName })).sort((a, b) => a.name.localeCompare(b.name));
}

// Read-only roles overview: TO role bindings + captains per season (data-derived).
export async function accessOverview() {
  const [toBindings, teamSeasons] = await Promise.all([
    prisma.roleBinding.findMany({ where: { tier: { in: ["OWNER", "TO"] } }, orderBy: { tier: "asc" } }),
    prisma.teamSeason.findMany({ include: { team: true, season: { select: { name: true } } }, orderBy: [{ season: { name: "asc" } }] }),
  ]);
  const capIds = [...new Set(teamSeasons.map((t) => t.captainPlayerId))];
  const caps = await prisma.player.findMany({ where: { id: { in: capIds } }, select: { id: true, displayName: true } });
  const capName = new Map(caps.map((c) => [c.id, c.displayName]));
  const captainsBySeason = new Map<string, { team: string; captain: string; teamSeasonId: string }[]>();
  for (const ts of teamSeasons) {
    const arr = captainsBySeason.get(ts.season.name) ?? [];
    arr.push({ team: ts.team.name, captain: capName.get(ts.captainPlayerId) ?? ts.captainPlayerId, teamSeasonId: ts.id });
    captainsBySeason.set(ts.season.name, arr);
  }
  return {
    toBindings: toBindings.map((b) => ({ discordRoleId: b.discordRoleId, tier: b.tier as string })),
    captainsBySeason: [...captainsBySeason.entries()].map(([season, rows]) => ({ season, rows })),
  };
}

export async function seasonOptions(): Promise<{ id: string; name: string }[]> {
  const seasons = await prisma.tourSeason.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  return seasons;
}
