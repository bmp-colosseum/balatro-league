// Admin permission helper. For now: env-pinned OWNER only.
// Future: query RoleBinding table + Discord guild member roles for full tier system.

import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function requireAdmin() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const user = session.user as { discordId?: string };
  const ownerId = process.env.LEAGUE_OWNER_DISCORD_ID;
  if (!ownerId || user.discordId !== ownerId) {
    redirect("/me?err=admin-only");
  }
  return { session, user };
}

export async function isAdminUser(): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;
  const user = session.user as { discordId?: string };
  const ownerId = process.env.LEAGUE_OWNER_DISCORD_ID;
  return !!ownerId && user.discordId === ownerId;
}
