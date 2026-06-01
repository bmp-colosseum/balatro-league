// Permission checks. Two sources, in order:
//   1. DB-backed RoleBinding rows (configured via /league set-role)
//   2. Env fallbacks (LEAGUE_OWNER_DISCORD_ID, LEAGUE_ADMIN_ROLE_ID) — kept so a fresh install
//      with no bindings yet can still bootstrap, and so the owner can never lock themselves out.
//
// Tier ordering: OWNER > ADMIN > HELPER. A higher tier always satisfies a lower-tier requirement.
//
// Role split:
//   OWNER  — full power including destructive ops + role binding
//   ADMIN  — season/division CRUD, force-resolve disputes, exports
//   HELPER — dispute mediation: join match channels, record verbal results
//   DEVOPS — pure notification target for infra alerts. Rank 0 so it
//            does NOT satisfy any league-admin permission check; it's
//            a ping target, not a privilege ladder rung.

import type { PermissionTier } from "@prisma/client";
import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";

const TIER_RANK: Record<PermissionTier, number> = {
  OWNER: 3,
  ADMIN: 2,
  HELPER: 1,
  DEVOPS: 0,
};

// Compute the highest tier a Discord user holds, given their guild roles.
// Returns null if they hold no tier at all.
export async function tierOf(
  member: GuildMember | null,
  userId: string,
): Promise<PermissionTier | null> {
  // Env owner always wins — guarantees the configured owner can't be locked out.
  if (env.LEAGUE_OWNER_DISCORD_ID && userId === env.LEAGUE_OWNER_DISCORD_ID) return "OWNER";

  if (!member) return null;

  const roleIds = Array.from(member.roles.cache.keys());

  const bindings = await prisma.roleBinding.findMany({
    where: { discordRoleId: { in: roleIds } },
  });

  let best: PermissionTier | null = null;
  const consider = (tier: PermissionTier) => {
    if (!best || TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  };

  for (const b of bindings) consider(b.tier);
  if (env.LEAGUE_ADMIN_ROLE_ID && roleIds.includes(env.LEAGUE_ADMIN_ROLE_ID)) consider("ADMIN");

  return best;
}

export async function hasTier(
  member: GuildMember | null,
  userId: string,
  required: PermissionTier,
): Promise<boolean> {
  const tier = await tierOf(member, userId);
  if (!tier) return false;
  return TIER_RANK[tier] >= TIER_RANK[required];
}

// Helper for command handlers. Replies ephemerally and returns false if not authorized.
export async function requireTier(
  interaction: ChatInputCommandInteraction,
  tier: PermissionTier,
): Promise<boolean> {
  const member =
    interaction.member && "roles" in interaction.member
      ? (interaction.member as GuildMember)
      : null;
  if (await hasTier(member, interaction.user.id, tier)) return true;

  await interaction.reply({
    content: `You need at least **${tier}** tier to run this command.`,
    flags: 64,
  });
  return false;
}

export async function requireHelper(interaction: ChatInputCommandInteraction): Promise<boolean> {
  return requireTier(interaction, "HELPER");
}

export async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  return requireTier(interaction, "ADMIN");
}

export async function requireOwner(interaction: ChatInputCommandInteraction): Promise<boolean> {
  return requireTier(interaction, "OWNER");
}
