// Team Tour bot — role reconciliation runner (Phase C scaffold).
//
// This is the THIN shell over the brain (lib/services/discord-roles.ts): provision
// the season's roles if needed, read current Discord members, compute the plan, and
// apply it. It's written against a small `GuildRoleClient` interface so the brain +
// flow are unit-testable WITHOUT discord.js or a token; the real bot passes an
// adapter backed by the league's src/discord-helpers.ts primitives.
import { prisma } from "../lib/db";
import { getRoleSyncPlan } from "../lib/services/discord-roles";

// The Discord operations the runner needs — implemented by the real bot with the
// league helpers (createGuildRole / addGuildMemberRole / removeGuildMemberRole) and
// guild.roles.members for the current snapshot.
export interface GuildRoleClient {
  createRole(name: string): Promise<string>; // → new role id
  membersWithRole(roleId: string): Promise<string[]>; // → discordIds
  addRole(discordId: string, roleId: string): Promise<void>;
  removeRole(discordId: string, roleId: string): Promise<void>;
}

export interface ReconcileResult {
  provisioned: { player?: string; captain?: string };
  players: { added: number; removed: number };
  captains: { added: number; removed: number };
  unmappable: number;
}

// Reconcile one season's Player + Captain roles to the derived roster state.
export async function reconcileSeasonRoles(seasonName: string, client: GuildRoleClient): Promise<ReconcileResult> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true, playerRoleId: true, captainRoleId: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);

  // 1. Provision missing roles.
  const provisioned: ReconcileResult["provisioned"] = {};
  let playerRoleId = season.playerRoleId;
  let captainRoleId = season.captainRoleId;
  if (!playerRoleId) {
    playerRoleId = await client.createRole(`TT ${season.name} Player`);
    provisioned.player = playerRoleId;
  }
  if (!captainRoleId) {
    captainRoleId = await client.createRole(`TT ${season.name} Captain`);
    provisioned.captain = captainRoleId;
  }
  if (provisioned.player || provisioned.captain) {
    await prisma.tourSeason.update({ where: { id: season.id }, data: { playerRoleId, captainRoleId } });
  }

  // 2. Snapshot current Discord membership, 3. compute the plan, 4. apply.
  const [curPlayers, curCaptains] = await Promise.all([client.membersWithRole(playerRoleId), client.membersWithRole(captainRoleId)]);
  const plan = await getRoleSyncPlan(seasonName, { players: curPlayers, captains: curCaptains });
  if (!plan) throw new Error("Could not build the role plan.");

  for (const id of plan.plan.players.add) await client.addRole(id, playerRoleId);
  for (const id of plan.plan.players.remove) await client.removeRole(id, playerRoleId);
  for (const id of plan.plan.captains.add) await client.addRole(id, captainRoleId);
  for (const id of plan.plan.captains.remove) await client.removeRole(id, captainRoleId);

  return {
    provisioned,
    players: { added: plan.plan.players.add.length, removed: plan.plan.players.remove.length },
    captains: { added: plan.plan.captains.add.length, removed: plan.plan.captains.remove.length },
    unmappable: plan.unmappable.length,
  };
}
