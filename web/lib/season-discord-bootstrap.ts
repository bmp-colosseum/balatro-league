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
import { ensureGuildCategory, createGuildRole, setRoleMentionable } from "@/lib/discord";
import { enqueueBootstrapDivision } from "@/lib/queue";
import { formatSeasonLabel } from "@/lib/format-season";

export async function runSeasonDiscordBootstrap(
  seasonId: string,
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
          members: { where: { status: "ACTIVE" }, select: { id: true } },
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
    const cat = await ensureGuildCategory(guildId, `🃏 League ${seasonLabel}`);
    if (cat) {
      await prisma.season.update({
        where: { id: season.id },
        data: { discordCategoryId: cat.id },
      });
    }
  }

  // Create the per-season "League Player" role once, NON-mentionable so members
  // can't mass-@ the whole league. The bot's one season-start announcement still
  // pings it via allowedMentions (which overrides the flag), so non-mentionable
  // costs us nothing. Created here at the season level — not in the per-division
  // jobs, which run 2-at-a-time and would race to create it. The division jobs
  // (enqueued below) assign it to their members.
  if (!season.leaguePlayerRoleId) {
    const role = await createGuildRole(guildId, `League Player — ${seasonLabel}`, { mentionable: false });
    if (role) {
      await prisma.season.update({ where: { id: season.id }, data: { leaguePlayerRoleId: role.id } });
    }
  } else {
    // Existing role (re-activation, or one created before this was enforced):
    // make sure it's non-mentionable now.
    await setRoleMentionable(guildId, season.leaguePlayerRoleId, false);
  }
  // Belt-and-suspenders: force every already-created division role for this
  // season non-mentionable too (new ones are created non-mentionable by the
  // bootstrap.division job). Covers roles created before this was enforced.
  for (const div of season.divisions) {
    if (div.discordRoleId) await setRoleMentionable(guildId, div.discordRoleId, false);
  }

  let queued = 0;
  for (const div of season.divisions) {
    if (div.members.length === 0) continue;
    // Re-enqueue when role/channel are missing — the worker is idempotent
    // and creates only what's absent.
    if (div.discordRoleId && div.discordChannelId) continue;
    await enqueueBootstrapDivision({ divisionId: div.id, guildId });
    queued++;
  }
  return queued;
}
