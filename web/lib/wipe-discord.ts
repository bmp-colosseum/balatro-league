// Discord-side counterpart to wipe-test-env. Deletes every league-
// related artifact the bot created in the guild — categories,
// channels, roles — and clears every DB column that pointed at them.
// Designed to leave the guild looking like the bot was never there.
//
// What gets deleted:
//   - Categories matching league name patterns ('🃏 Balatro League',
//     '🎴 Matches', '🃏 Season *', '📦 * Archive')
//   - All channels inside those categories (regardless of name —
//     anything sitting under a league category counts as league
//     state)
//   - Roles matching league name patterns ('League *', 'Season N · *',
//     '🏆 Season N · * Champion')
//   - Roles tracked in Division.discordRoleId (in case admin renamed
//     them — the ID still wins)
//   - Channels tracked in LeagueConfig channel ID keys + Division.
//     discordChannelId (same defensive idea)
//
// What gets cleared in the DB after:
//   - LeagueConfig keys for bot-commands / backups / devops /
//     challenges / announcements / discord-server-invite-url
//   - RoleBinding rows
//   - Division.discordRoleId, Division.discordChannelId,
//     Season.discordCategoryId
//
// What stays:
//   - The guild itself (we don't have permissions to delete guilds
//     and we wouldn't want to anyway)
//   - @everyone role
//   - Anything the bot didn't create (server's own #general, etc.)

import { prisma } from "@/lib/prisma";
import {
  deleteChannel,
  deleteGuildRole,
  listAllGuildChannels,
  listGuildRoles,
} from "@/lib/discord";
import { recordAudit, type AuditActor } from "@/lib/audit";

const CATEGORY_NAME_PATTERNS: RegExp[] = [
  /^🃏 Balatro League$/i,
  /^🎴 Matches$/i,
  /^🃏 Season /i,
  /^📦 .* Archive$/i,
];

const ROLE_NAME_PATTERNS: RegExp[] = [
  /^League (Player|Admin|Helper|DevOps)$/i,
  /^Season \d+ · /i,
  /^🏆 Season \d+ · .* Champion$/i,
];

const CONFIG_CHANNEL_KEYS = [
  "bot_commands_channel_id",
  "backup_channel_id",
  "devops_channel_id",
  "challenges_channel_id",
  "announcements_channel_id",
  "results_channel_id",
];

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

  // Phase 1: collect IDs from the DB so we can delete by id even if
  // the channel/role got renamed since creation.
  const divisions = await prisma.division.findMany({
    where: { OR: [{ discordChannelId: { not: null } }, { discordRoleId: { not: null } }] },
    select: { discordChannelId: true, discordRoleId: true },
  });
  const knownChannelIds = new Set<string>();
  const knownRoleIds = new Set<string>();
  for (const d of divisions) {
    if (d.discordChannelId) knownChannelIds.add(d.discordChannelId);
    if (d.discordRoleId) knownRoleIds.add(d.discordRoleId);
  }
  const configChannelIds = await prisma.leagueConfig.findMany({
    where: { key: { in: CONFIG_CHANNEL_KEYS } },
    select: { value: true },
  });
  for (const c of configChannelIds) {
    if (c.value) knownChannelIds.add(c.value);
  }
  const boundRoles = await prisma.roleBinding.findMany({
    select: { discordRoleId: true },
  });
  for (const r of boundRoles) knownRoleIds.add(r.discordRoleId);

  // Phase 2: enumerate the guild to find league-pattern matches by name,
  // unioned with the known-id set from above.
  const [allChannels, allRoles] = await Promise.all([
    listAllGuildChannels(guildId),
    listGuildRoles(guildId),
  ]);

  const leagueCategories = allChannels.filter(
    (c) =>
      c.type === CHANNEL_TYPE_CATEGORY &&
      CATEGORY_NAME_PATTERNS.some((re) => re.test(c.name)),
  );
  const categoryIds = new Set(leagueCategories.map((c) => c.id));

  // Channels to delete: anything sitting under a league category OR
  // explicitly tracked via DB.
  const channelsToDelete = allChannels.filter(
    (c) =>
      c.type !== CHANNEL_TYPE_CATEGORY &&
      (knownChannelIds.has(c.id) || (c.parent_id && categoryIds.has(c.parent_id))),
  );

  // Delete channels first (categories can't be deleted while they
  // still contain children).
  for (const c of channelsToDelete) {
    const ok = await deleteChannel(c.id);
    if (ok) result.channelsDeleted++;
  }
  // Then delete the categories themselves.
  for (const cat of leagueCategories) {
    const ok = await deleteChannel(cat.id);
    if (ok) result.categoriesDeleted++;
  }
  // Plus any orphan IDs from the DB that didn't appear in the guild
  // listing (channel was already deleted, but the DB still pointed at
  // it). deleteChannel returns true on 404 so this won't blow up.
  const listedChannelIds = new Set(allChannels.map((c) => c.id));
  for (const id of knownChannelIds) {
    if (!listedChannelIds.has(id)) {
      await deleteChannel(id); // Returns true on 404 — no count bump.
    }
  }

  // Phase 3: roles. Discord refuses to delete `managed` roles (bot's
  // own integration role, premium subscriber role, etc.) — filter those
  // out so we don't burn API budget on guaranteed-409s.
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
    where: { key: { in: CONFIG_CHANNEL_KEYS } },
  });
  result.configKeysCleared = cleared.count;

  const bindings = await prisma.roleBinding.deleteMany();
  result.roleBindingsDeleted = bindings.count;

  const divisionsCleared = await prisma.division.updateMany({
    where: { OR: [{ discordChannelId: { not: null } }, { discordRoleId: { not: null } }] },
    data: { discordChannelId: null, discordRoleId: null },
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
