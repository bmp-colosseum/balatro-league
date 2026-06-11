// Admin permission helper. Checks (in order):
//   1. Env-pinned OWNER (LEAGUE_OWNER_DISCORD_ID) — always passes.
//   2. DB RoleBinding rows for the user's guild roles — needs Discord REST lookup.
//
// Cached per-request via React's auth() (next-auth memoizes within a render).

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { fetchGuildMember } from "@/lib/discord";

// DEVOPS = 0: present so the table covers every PermissionTier value,
// but ranks below HELPER so it never satisfies a league-admin check.
// It's a notification target, not a permission ladder rung.
const TIER_RANK = { OWNER: 3, ADMIN: 2, HELPER: 1, DEVOPS: 0 } as const;
type Tier = keyof typeof TIER_RANK;

export async function tierOfCurrentUser(): Promise<Tier | null> {
  const session = await auth();
  if (!session?.user) return null;
  const user = session.user as { discordId?: string };
  if (!user.discordId) return null;

  // Env-pinned owner always wins
  if (process.env.LEAGUE_OWNER_DISCORD_ID && user.discordId === process.env.LEAGUE_OWNER_DISCORD_ID) {
    return "OWNER";
  }

  // Need guild ID to look up roles
  if (!process.env.DISCORD_GUILD_ID) return null;

  const member = await fetchGuildMember(process.env.DISCORD_GUILD_ID, user.discordId);
  if (!member) return null;

  // Fetch all role bindings, see if the user has any of those roles
  const bindings = await prisma.roleBinding.findMany({
    where: { discordRoleId: { in: member.roles } },
  });
  if (bindings.length === 0) {
    // Legacy env fallback
    if (process.env.LEAGUE_ADMIN_ROLE_ID && member.roles.includes(process.env.LEAGUE_ADMIN_ROLE_ID)) {
      return "ADMIN";
    }
    return null;
  }

  let best: Tier | null = null;
  for (const b of bindings) {
    if (!best || TIER_RANK[b.tier as Tier] > TIER_RANK[best]) best = b.tier as Tier;
  }
  return best;
}

export async function hasTier(required: Tier): Promise<boolean> {
  const tier = await tierOfCurrentUser();
  if (!tier) return false;
  return TIER_RANK[tier] >= TIER_RANK[required];
}

export async function requireAdmin() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");
  if (!(await hasTier("ADMIN"))) redirect("/me?err=admin-only");
  return { session, user: session.user as { discordId: string; name?: string | null } };
}

export async function isAdminUser(): Promise<boolean> {
  return hasTier("ADMIN");
}

// OWNER-only gate. Role binding (role → tier) is owner-only so an ADMIN
// can't bind a role to OWNER and escalate themselves. Mirrors the bot's
// /league set-role, which is also OWNER-gated.
export async function requireOwner() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");
  if (!(await hasTier("OWNER"))) redirect("/admin/config?err=owner-only");
  return { session, user: session.user as { discordId: string; name?: string | null } };
}

// DevOps access is checked explicitly (not via hasTier) because DEVOPS
// sits OUTSIDE the league-admin ladder — a user who is ADMIN does NOT
// automatically have DevOps access. DevOps is a separate, parallel
// "infra" role for config that league mods/helpers shouldn't see or
// touch (e.g. timeouts, integrations).
export async function hasDevOpsBinding(): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;
  const user = session.user as { discordId?: string };
  if (!user.discordId || !process.env.DISCORD_GUILD_ID) return false;
  const member = await fetchGuildMember(process.env.DISCORD_GUILD_ID, user.discordId);
  if (!member) return false;
  const bindings = await prisma.roleBinding.findMany({
    where: { discordRoleId: { in: member.roles }, tier: "DEVOPS" },
    select: { id: true },
  });
  return bindings.length > 0;
}

// Page-level gate for DevOps-only pages. OWNER (env-pinned) passes
// unconditionally; otherwise the user must have a DEVOPS role binding.
export async function requireOwnerOrDevops() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");
  const user = session.user as { discordId: string; name?: string | null };
  const isOwner = !!process.env.LEAGUE_OWNER_DISCORD_ID && user.discordId === process.env.LEAGUE_OWNER_DISCORD_ID;
  if (!isOwner && !(await hasDevOpsBinding())) redirect("/me?err=devops-only");
  return { session, user };
}
