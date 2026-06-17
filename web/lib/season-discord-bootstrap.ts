// Core of the season Discord bootstrap — per-division roles + channels.
//
// SECURITY: this is a PLAIN module, deliberately NOT a "use server" action.
// Every export of a "use server" file is registered as a network-reachable RPC
// endpoint (dispatched by action-id, which is not an auth boundary), so an
// exported action with no requireAdmin() is effectively a public endpoint.
// Keeping this here means only its server-side callers (the guarded admin
// actions + the activation flow) can run it — it has no action-id.
//
// Idempotent: divisions already fully set up are skipped, empty divisions are
// skipped, and the season-category create only fires once. Returns the number
// of bootstrap jobs queued, or null when the guild/season context is missing.

import { prisma } from "@/lib/prisma";
import { ensureGuildCategory } from "@/lib/discord";
import { enqueueBootstrapDivision } from "@/lib/queue";
import { formatSeasonLabel } from "@/lib/format-season";

export async function runSeasonDiscordBootstrap(
  seasonId: string,
  opts: { rebuildThreads?: boolean } = {},
): Promise<number | null> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("DISCORD_GUILD_ID not set; skipping season Discord bootstrap");
    return null;
  }
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          discordRoleId: true,
          discordChannelId: true,
          subGroupThreadIds: true,
          members: { where: { status: "ACTIVE" }, select: { assignmentGroup: true } },
        },
      },
    },
  });
  if (!season) return null;

  // If admin didn't set a category id, auto-create '🃏 Season Name' so each
  // season gets a clean home. Done synchronously so the worker jobs see the
  // parent id immediately.
  const seasonLabel = formatSeasonLabel(season);
  if (!season.discordCategoryId) {
    const cat = await ensureGuildCategory(guildId, `🃏 ${seasonLabel}`);
    if (cat) {
      await prisma.season.update({
        where: { id: season.id },
        data: { discordCategoryId: cat.id },
      });
    }
  }

  let queued = 0;
  for (const div of season.divisions) {
    if (div.members.length === 0) continue;
    const hasGroups = div.members.some((m) => m.assignmentGroup != null);
    // Rebuild pass: only divisions that already have a channel + sub-groups,
    // forced (delete + recreate their threads from the current grouping).
    if (opts.rebuildThreads) {
      if (!div.discordChannelId || !hasGroups) continue;
      await enqueueBootstrapDivision({ divisionId: div.id, guildId, rebuildThreads: true });
      queued++;
      continue;
    }
    // Normal pass: re-enqueue when role/channel are missing OR any sub-group
    // thread is — the worker is idempotent and creates only what's absent.
    const groups = new Set(div.members.map((m) => m.assignmentGroup).filter((g): g is number => g != null));
    const threads = (div.subGroupThreadIds as Record<string, string> | null) ?? {};
    const threadsComplete = [...groups].every((g) => threads[String(g)]);
    if (div.discordRoleId && div.discordChannelId && threadsComplete) continue;
    await enqueueBootstrapDivision({ divisionId: div.id, guildId });
    queued++;
  }
  return queued;
}
