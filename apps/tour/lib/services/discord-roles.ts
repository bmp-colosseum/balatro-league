// Discord role reconciliation — the "brain" the Tour bot will use to keep guild
// roles in sync with the roster, with ZERO bot/token needed here. It DERIVES the
// desired role membership (who should hold the season's Player / Captain role) from
// the roster + captain + weekly move-log data, and a pure diff turns "desired vs
// what Discord currently has" into an add/remove plan. The bot (Phase C) just
// fetches the current members, calls planRoleReconciliation, and applies it via the
// league's addGuildMemberRole / removeGuildMemberRole helpers.
//
// Role model (owner choice): ONE Player role + ONE Captain role per season
// (TourSeason.playerRoleId / captainRoleId). Identity is the player's discordId;
// legacy players without one can't be roled (surfaced as `unmappable`).
import { prisma } from "../db";

// Players currently departed from a team (QUIT/BANNED, not later REINSTATED), folding
// the move log "as of now" (all effective). Mirrors deriveLineup's gone logic.
function currentlyGone(moves: { kind: string; playerId: string; effectiveWeek: number; createdAt: Date }[]): Set<string> {
  const gone = new Map<string, boolean>();
  for (const m of [...moves].sort((a, b) => a.effectiveWeek - b.effectiveWeek || +a.createdAt - +b.createdAt)) {
    if (m.kind === "QUIT" || m.kind === "BANNED") gone.set(m.playerId, true);
    else if (m.kind === "REINSTATED") gone.set(m.playerId, false);
  }
  return new Set([...gone.entries()].filter(([, g]) => g).map(([id]) => id));
}

export interface DesiredRoles {
  seasonName: string;
  playerRoleId: string | null; // null = not provisioned yet (bot must create)
  captainRoleId: string | null;
  players: string[]; // discordIds who should hold the Player role
  captains: string[]; // discordIds who should hold the Captain role
  unmappable: { playerId: string; name: string; role: "player" | "captain" }[]; // no discordId
}

// Derive the desired role membership for a season from the data.
export async function getDesiredRoles(seasonName: string): Promise<DesiredRoles | null> {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    select: { id: true, name: true, playerRoleId: true, captainRoleId: true },
  });
  if (!season) return null;

  const [teamSeasons, moves] = await Promise.all([
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { rosters: { include: { entries: true } } } }),
    prisma.rosterMove.findMany({ where: { seasonId: season.id }, select: { kind: true, playerId: true, effectiveWeek: true, createdAt: true, teamSeasonId: true } }),
  ]);

  const movesByTeam = new Map<string, typeof moves>();
  for (const m of moves) {
    const arr = movesByTeam.get(m.teamSeasonId) ?? [];
    arr.push(m);
    movesByTeam.set(m.teamSeasonId, arr);
  }

  const memberIds = new Set<string>();
  const captainIds = new Set<string>();
  for (const ts of teamSeasons) {
    const gone = currentlyGone(movesByTeam.get(ts.id) ?? []);
    for (const r of ts.rosters) {
      for (const e of r.entries) {
        if (gone.has(e.playerId)) continue;
        memberIds.add(e.playerId);
        // Co-captains hold the Captain role too (same team powers → same channels).
        if (e.isCoCaptain) captainIds.add(e.playerId);
      }
    }
    if (ts.captainPlayerId && !gone.has(ts.captainPlayerId)) captainIds.add(ts.captainPlayerId);
  }

  const all = [...new Set([...memberIds, ...captainIds])];
  const players = await prisma.player.findMany({ where: { id: { in: all } }, select: { id: true, displayName: true, discordId: true } });
  const byId = new Map(players.map((p) => [p.id, p]));
  // Real Discord ids are numeric snowflakes; legacy sentinels (legacy:slug) aren't.
  const mappable = (id: string) => /^\d+$/.test(id);

  const playerDiscord: string[] = [];
  const captainDiscord: string[] = [];
  const unmappable: DesiredRoles["unmappable"] = [];
  for (const pid of memberIds) {
    const p = byId.get(pid);
    if (p && mappable(p.discordId)) playerDiscord.push(p.discordId);
    else if (p) unmappable.push({ playerId: pid, name: p.displayName, role: "player" });
  }
  for (const pid of captainIds) {
    const p = byId.get(pid);
    if (p && mappable(p.discordId)) captainDiscord.push(p.discordId);
    else if (p) unmappable.push({ playerId: pid, name: p.displayName, role: "captain" });
  }

  return {
    seasonName: season.name,
    playerRoleId: season.playerRoleId,
    captainRoleId: season.captainRoleId,
    players: [...new Set(playerDiscord)],
    captains: [...new Set(captainDiscord)],
    unmappable,
  };
}

// Admin preview (no token): the derived role membership with NAMES + the
// provisioning status, so a TO can see "who'll get roled / who can't yet".
export async function getRolePreview(seasonName: string) {
  const d = await getDesiredRoles(seasonName);
  if (!d) return null;
  const discordIds = [...new Set([...d.players, ...d.captains])];
  const players = await prisma.player.findMany({ where: { discordId: { in: discordIds } }, select: { discordId: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.discordId, p.displayName]));
  const name = (did: string) => nameOf.get(did) ?? did;
  return {
    seasonName: d.seasonName,
    provisioned: !!d.playerRoleId && !!d.captainRoleId,
    playerRoleId: d.playerRoleId,
    captainRoleId: d.captainRoleId,
    players: d.players.map(name).sort(),
    captains: d.captains.map(name).sort(),
    unmappable: d.unmappable,
  };
}

export interface RolePlan {
  add: string[]; // discordIds to grant the role
  remove: string[]; // discordIds to revoke the role
}

// Pure diff: desired membership vs the role's CURRENT members (from Discord) →
// what to add and remove. No DB, no Discord — trivially testable.
export function planRoleReconciliation(desired: readonly string[], current: readonly string[]): RolePlan {
  const d = new Set(desired);
  const c = new Set(current);
  return {
    add: [...d].filter((id) => !c.has(id)),
    remove: [...c].filter((id) => !d.has(id)),
  };
}

// The full plan the bot applies: for each role, the add/remove vs the current Discord
// members it passes in (omit `current` for a preview = everything is an "add").
export async function getRoleSyncPlan(
  seasonName: string,
  current?: { players?: string[]; captains?: string[] },
): Promise<(DesiredRoles & { plan: { players: RolePlan; captains: RolePlan }; needsProvisioning: boolean }) | null> {
  const desired = await getDesiredRoles(seasonName);
  if (!desired) return null;
  return {
    ...desired,
    plan: {
      players: planRoleReconciliation(desired.players, current?.players ?? []),
      captains: planRoleReconciliation(desired.captains, current?.captains ?? []),
    },
    needsProvisioning: !desired.playerRoleId || !desired.captainRoleId,
  };
}
