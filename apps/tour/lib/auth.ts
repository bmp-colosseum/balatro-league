// Auth gate. Real auth = NextAuth Discord OAuth (auth.ts) + permission tiers.
//
// Tier resolution (design §13.7), in order:
//   1. env-pinned ids — TOUR_OWNER_DISCORD_IDS / TOUR_TO_DISCORD_IDS /
//      TOUR_HELPER_DISCORD_IDS (comma-separated). The reliable path pre-bot, and
//      works across the shared league SSO (only needs the discordId).
//   2. RoleBinding — the user's Tour-guild role ids (captured at sign-in when
//      TOUR_GUILD_ID + the guilds.members.read grant are present) → highest tier.
//   3. otherwise PLAYER (signed in) or GUEST.
//   • TOUR_DEV_ADMIN=1 forces OWNER locally.
//
// Services in lib/services/ stay auth-agnostic; the CALLER (route/action/page) gates.
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

export type Tier = "OWNER" | "TO" | "HELPER" | "DEVOPS" | "PLAYER" | "GUEST";

export interface Viewer {
  authenticated: boolean;
  discordId: string | null;
  name: string | null;
  avatar: string | null;
  tier: Tier;
  playerId: string | null; // resolved core Player.id when the discordId is mapped
}

const ADMIN_TIERS: readonly Tier[] = ["OWNER", "TO"];
const RANK: Record<string, number> = { OWNER: 4, TO: 3, HELPER: 2, DEVOPS: 1 };

const idList = (name: string): string[] =>
  (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Pure-ish tier resolution from a discordId + the user's guild role ids.
export async function resolveTier(discordId: string | null, roleIds: string[]): Promise<Tier> {
  if (!discordId) return "GUEST";
  if (idList("TOUR_OWNER_DISCORD_IDS").includes(discordId)) return "OWNER";
  if (idList("TOUR_TO_DISCORD_IDS").includes(discordId)) return "TO";
  if (idList("TOUR_HELPER_DISCORD_IDS").includes(discordId)) return "HELPER";
  if (roleIds.length) {
    const bindings = await prisma.roleBinding.findMany({ where: { discordRoleId: { in: roleIds } } });
    let best: Tier | null = null;
    let bestRank = 0;
    for (const b of bindings) {
      const r = RANK[b.tier] ?? 0;
      if (r > bestRank) {
        bestRank = r;
        best = b.tier as Tier;
      }
    }
    if (best) return best;
  }
  return "PLAYER";
}

// The current viewer (session + resolved tier + mapped player). Safe to call
// anywhere on the server; returns a GUEST when not signed in.
export async function getViewer(): Promise<Viewer> {
  const devOwner = process.env.TOUR_DEV_ADMIN === "1";
  // auth() can THROW synchronously (e.g. a misconfigured/missing AUTH_SECRET), which
  // a trailing .catch() wouldn't trap — so wrap it. A failed session = a GUEST, never
  // a crashed page.
  let session: Session | null = null;
  try {
    session = (await auth()) as Session | null;
  } catch {
    session = null;
  }
  const user = session?.user as { discordId?: string; name?: string | null; avatar?: string | null } | undefined;
  const discordId = user?.discordId ?? null;
  const roleIds = (session as { roleIds?: string[] } | null)?.roleIds ?? [];

  let tier = await resolveTier(discordId, roleIds);
  if (devOwner && !ADMIN_TIERS.includes(tier)) tier = "OWNER";

  let playerId: string | null = null;
  if (discordId) {
    const p = await prisma.player.findUnique({ where: { discordId }, select: { id: true } });
    playerId = p?.id ?? null;
  }

  return {
    authenticated: !!discordId || devOwner,
    discordId,
    name: user?.name ?? null,
    avatar: user?.avatar ?? null,
    tier,
    playerId,
  };
}

export async function isAdmin(): Promise<boolean> {
  if (process.env.TOUR_DEV_ADMIN === "1") return true;
  const v = await getViewer();
  return ADMIN_TIERS.includes(v.tier);
}

export async function assertAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("Forbidden: admin only");
}

// API routes: a Bearer TOUR_ADMIN_TOKEN (programmatic callers / the bot), else the
// signed-in admin check.
export async function isApiAdmin(req: Request): Promise<boolean> {
  const token = process.env.TOUR_ADMIN_TOKEN;
  if (token && req.headers.get("authorization") === `Bearer ${token}`) return true;
  return isAdmin();
}
