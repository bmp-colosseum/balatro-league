// Discord-side counterpart to wipe-test-env. Deletes the league artifacts the
// bot created in the guild — by TRACKED ID, not by name — and clears the DB
// columns that pointed at them. Designed to leave the guild looking like the
// bot was never there, WITHOUT touching anything the bot didn't record.
//
// What gets deleted (all by id, so a renamed channel/role still goes):
//   - Categories: the configured league_category_id + matches_category_id,
//     plus every Season.discordCategoryId.
//   - Channels: every channel tracked in a LeagueConfig channel-id key or
//     Division.discordChannelId, PLUS every channel sitting under one of the
//     tracked categories above (catches league-chat / league-signups etc.
//     that have no dedicated config key).
//   - Roles: every Division.discordRoleId + RoleBinding role, plus roles
//     matching the bot's own role-name patterns (the League Player / season
//     champion / tier roles aren't tracked by id anywhere else).
//
// What it deliberately does NOT do anymore: sweep channels by matching a
// category *name* (e.g. "🃏 Balatro League"). That was the over-deletion
// risk — it nuked anything an admin parked under a league category and could
// false-match a coincidentally-named category. Deletion is now id-driven.
//
// ⚠️ Caveat for the configured-category feature: if league_category_id /
// matches_category_id point at a SHARED category you didn't let the bot
// create, the child sweep WILL delete everything in it. Only point those at
// categories the bot owns if you intend to wipe them.
//
// What stays: the guild + @everyone, managed roles, and anything the bot
// never recorded creating (untracked categories/channels — delete manually).

import { prisma } from "@/lib/prisma";
import {
  deleteChannel,
  deleteGuildRole,
  listAllGuildChannels,
  listGuildRoles,
} from "@/lib/discord";
import { recordAudit, type AuditActor } from "@/lib/audit";

// Roles the bot creates that aren't tracked by id (Player role + per-season
// champion/tier roles). Division roles + bound roles are deleted by id; these
// are the name-only stragglers. Patterns are specific enough to be safe.
const ROLE_NAME_PATTERNS: RegExp[] = [
  // \b after the word so "League Player — Season 2" matches too (the per-season
  // roster role), not just bare "League Player".
  /^League (Player|Admin|Helper|DevOps)\b/i,
  // Division roles "Season N: <div>" and champion roles "🏆 Season N <div>
  // Champion". (Older "Season N · …" with a middot still matches the [: ·].)
  /^Season \d+[: ·]/i,
  /^🏆 Season \d+ .* Champion$/i,
];

// Every LeagueConfig key that holds a channel id the bot created.
const CONFIG_CHANNEL_KEYS = [
  "league_info_channel_id",
  "bot_commands_channel_id",
  "results_channel_id",
  "results_human_channel_id",
  "announcements_channel_id",
  "feedback_channel_id",
  "admin_channel_id",
  "support_channel_id",
  "general_channel_id",
  "backup_channel_id",
  "devops_channel_id",
  "challenges_channel_id",
  "league_matches_channel_id",
];
// LeagueConfig keys that hold a CATEGORY id.
const CONFIG_CATEGORY_KEYS = ["league_category_id", "matches_category_id"];

const CHANNEL_TYPE_CATEGORY = 4;

export interface WipeDiscordResult {
  categoriesDeleted: number;
  channelsDeleted: number;
  rolesDeleted: number;
  configKeysCleared: number;
  roleBindingsDeleted: number;
  divisionsCleared: number;
  seasonsCleared: number;
}

export async function wipeDiscordLeagueState(
  guildId: string,
  actor: AuditActor,
): Promise<WipeDiscordResult> {
  const result: WipeDiscordResult = {
    categoriesDeleted: 0,
    channelsDeleted: 0,
    rolesDeleted: 0,
    configKeysCleared: 0,
    roleBindingsDeleted: 0,
    divisionsCleared: 0,
    seasonsCleared: 0,
  };

  // Phase 1: collect tracked IDs from the DB — channels, categories, roles.
  const divisions = await prisma.division.findMany({
    where: {
      OR: [
        { discordChannelId: { not: null } },
        { discordRoleId: { not: null } },
        { championRoleId: { not: null } },
      ],
    },
    select: { discordChannelId: true, discordRoleId: true, championRoleId: true },
  });
  const knownChannelIds = new Set<string>();
  const knownRoleIds = new Set<string>();
  for (const d of divisions) {
    if (d.discordChannelId) knownChannelIds.add(d.discordChannelId);
    if (d.discordRoleId) knownRoleIds.add(d.discordRoleId);
    if (d.championRoleId) knownRoleIds.add(d.championRoleId);
  }

  const configRows = await prisma.leagueConfig.findMany({
    where: { key: { in: [...CONFIG_CHANNEL_KEYS, ...CONFIG_CATEGORY_KEYS] } },
    select: { key: true, value: true },
  });
  const knownCategoryIds = new Set<string>();
  for (const c of configRows) {
    if (!c.value) continue;
    if (CONFIG_CATEGORY_KEYS.includes(c.key)) knownCategoryIds.add(c.value);
    else knownChannelIds.add(c.value);
  }

  // Season categories are always bot-created — wipe them + their children.
  // Also the per-season "League Player" role.
  const seasonCats = await prisma.season.findMany({
    where: { OR: [{ discordCategoryId: { not: null } }, { leaguePlayerRoleId: { not: null } }] },
    select: { discordCategoryId: true, leaguePlayerRoleId: true },
  });
  for (const s of seasonCats) {
    if (s.discordCategoryId) knownCategoryIds.add(s.discordCategoryId);
    if (s.leaguePlayerRoleId) knownRoleIds.add(s.leaguePlayerRoleId);
  }

  const boundRoles = await prisma.roleBinding.findMany({ select: { discordRoleId: true } });
  for (const r of boundRoles) knownRoleIds.add(r.discordRoleId);

  // Phase 2: enumerate the guild.
  const [allChannels, allRoles] = await Promise.all([
    listAllGuildChannels(guildId),
    listGuildRoles(guildId),
  ]);

  // Channels to delete: tracked by id OR sitting under a tracked category.
  const channelsToDelete = allChannels.filter(
    (c) =>
      c.type !== CHANNEL_TYPE_CATEGORY &&
      (knownChannelIds.has(c.id) || (c.parent_id != null && knownCategoryIds.has(c.parent_id))),
  );
  for (const c of channelsToDelete) {
    const ok = await deleteChannel(c.id);
    if (ok) result.channelsDeleted++;
  }

  // Then the tracked categories themselves (now childless).
  const categoriesToDelete = allChannels.filter(
    (c) => c.type === CHANNEL_TYPE_CATEGORY && knownCategoryIds.has(c.id),
  );
  for (const cat of categoriesToDelete) {
    const ok = await deleteChannel(cat.id);
    if (ok) result.categoriesDeleted++;
  }

  // Orphan tracked channel IDs that didn't appear in the live listing
  // (already deleted, but the DB still pointed at them). 404 = no-op.
  const listedChannelIds = new Set(allChannels.map((c) => c.id));
  for (const id of knownChannelIds) {
    if (!listedChannelIds.has(id)) await deleteChannel(id);
  }

  // Phase 3: roles — tracked by id OR matching the bot's role-name patterns.
  // Managed roles (bot integration, booster) + @everyone are never touched.
  const rolesToDelete = allRoles.filter(
    (r) =>
      !r.managed &&
      r.name !== "@everyone" &&
      (knownRoleIds.has(r.id) || ROLE_NAME_PATTERNS.some((re) => re.test(r.name))),
  );
  for (const r of rolesToDelete) {
    const ok = await deleteGuildRole(guildId, r.id);
    if (ok) result.rolesDeleted++;
  }

  // Phase 4: clear the DB columns + LeagueConfig keys + RoleBindings.
  const cleared = await prisma.leagueConfig.deleteMany({
    where: { key: { in: [...CONFIG_CHANNEL_KEYS, ...CONFIG_CATEGORY_KEYS] } },
  });
  result.configKeysCleared = cleared.count;

  const bindings = await prisma.roleBinding.deleteMany();
  result.roleBindingsDeleted = bindings.count;

  const divisionsCleared = await prisma.division.updateMany({
    where: {
      OR: [
        { discordChannelId: { not: null } },
        { discordRoleId: { not: null } },
        { championRoleId: { not: null } },
      ],
    },
    data: { discordChannelId: null, discordRoleId: null, championRoleId: null },
  });
  result.divisionsCleared = divisionsCleared.count;

  const seasonsCleared = await prisma.season.updateMany({
    where: { discordCategoryId: { not: null } },
    data: { discordCategoryId: null },
  });
  result.seasonsCleared = seasonsCleared.count;

  recordAudit({
    actor,
    action: "test-env.wipe-discord",
    targetType: "Discord",
    targetId: guildId,
    summary: `Wiped Discord state (${result.channelsDeleted} channels, ${result.categoriesDeleted} categories, ${result.rolesDeleted} roles)`,
    metadata: { ...result },
  });

  return result;
}
