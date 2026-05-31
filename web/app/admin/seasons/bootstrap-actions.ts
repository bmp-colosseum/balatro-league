"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import {
  addGuildMemberRole,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
} from "@/lib/discord";

// Save (or clear) the Discord category id a season's division channels
// should be nested under.
export async function setSeasonDiscordCategory(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const categoryIdRaw = String(formData.get("discordCategoryId") ?? "").trim();
  if (!id) return;
  const discordCategoryId = categoryIdRaw === "" ? null : categoryIdRaw;
  await prisma.season.update({ where: { id }, data: { discordCategoryId } });
  revalidatePath("/admin/seasons");
}

// Bootstrap Discord channels + roles for every division in a season.
// Per division:
//   - Create a role (color 0, mentionable) named e.g. "S2-Legendary"
//   - Assign that role to every ACTIVE member
//   - Create a private text channel under the season's category that only the
//     role can see, with a welcome message pinging all members + the role
//   - Persist the discordRoleId + discordChannelId back on the Division row
//
// Skips divisions that already have both ids set (idempotent re-runs).
export async function bootstrapSeasonDiscord(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("DISCORD_GUILD_ID not set; skipping bootstrap");
    return;
  }

  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: {
            where: { status: "ACTIVE" },
            include: { player: true },
          },
        },
      },
    },
  });
  if (!season) return;

  const parentId = season.discordCategoryId ?? undefined;

  // Look up every Discord role bound to ADMIN or MOD tier so the new
  // private division channels are visible to staff as well as the
  // division's own role. (Owners are env-pinned via LEAGUE_OWNER_DISCORD_ID
  // and don't need a role.)
  const staffBindings = await prisma.roleBinding.findMany({
    where: { tier: { in: ["ADMIN", "MOD"] } },
  });
  const staffRoleIds = staffBindings.map((b) => b.discordRoleId);

  for (const div of season.divisions) {
    if (div.discordRoleId && div.discordChannelId) continue; // already set up
    if (div.members.length === 0) continue; // no one in this division

    // 1) Role
    let roleId = div.discordRoleId;
    if (!roleId) {
      const role = await createGuildRole(guildId, `${season.name} · ${div.name}`, { mentionable: true });
      if (!role) {
        console.warn(`[bootstrap] failed to create role for division ${div.id}`);
        continue;
      }
      roleId = role.id;
    }

    // 2) Assign role to all members
    for (const m of div.members) {
      await addGuildMemberRole(guildId, m.player.discordId, roleId);
    }

    // 3) Channel — visible to the division's own role + staff roles
    let channelId = div.discordChannelId;
    if (!channelId) {
      const channelName = div.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      // Discord caps a category at 50 channels. Try the configured parent
      // first; if creation fails (likely because the category is full or
      // the parent doesn't exist), fall back to no parent so the bootstrap
      // doesn't grind to a halt. Admin can drag channels into a fresh
      // overflow category afterward.
      let channel = await createGuildTextChannel(guildId, channelName, {
        parentId,
        topic: `${season.name} — ${div.tier.name} tier, division ${div.name}`,
        visibleToRoleIds: [roleId, ...staffRoleIds],
      });
      if (!channel && parentId) {
        console.warn(`[bootstrap] couldn't place ${channelName} under category ${parentId} — falling back to top level (likely 50-channel cap)`);
        channel = await createGuildTextChannel(guildId, channelName, {
          topic: `${season.name} — ${div.tier.name} tier, division ${div.name} (no category — overflow)`,
          visibleToRoleIds: [roleId, ...staffRoleIds],
        });
      }
      if (!channel) {
        console.warn(`[bootstrap] failed to create channel for division ${div.id}`);
        await prisma.division.update({ where: { id: div.id }, data: { discordRoleId: roleId } });
        continue;
      }
      channelId = channel.id;

      // 4) Welcome message — full onboarding for everyone in this division
      const mentions = div.members.map((m) => `<@${m.player.discordId}>`).join(" ");
      const memberList = div.members
        .map((m, i) => `${i + 1}. <@${m.player.discordId}>`)
        .join("\n");
      const setsToPlay = (div.members.length * (div.members.length - 1)) / 2;
      const welcome = [
        `# 🃏 Welcome to ${div.name}`,
        `_${season.name} · ${div.tier.name} tier_`,
        ``,
        mentions,
        ``,
        `**Your opponents (${div.members.length}):**`,
        memberList,
        ``,
        `**What to do**`,
        `• Play **every other person** in this list once — best-of-2 (${setsToPlay} sets total per player).`,
        `• Schedule in this channel. DMs work too.`,
        `• Use \`/start-match @opponent\` for the guided ban/pick flow (the bot picks the deck/stake for you), OR just play in Balatro and use \`/report @opponent result:2-0|1-1|0-2\` to log it.`,
        ``,
        `**Standings + your schedule:** <https://www.balatroleague.com/divisions/${div.id}>`,
        ``,
        `Good luck. 🎴`,
      ].join("\n");
      await postChannelMessage(channelId, { content: welcome });
    }

    // 5) Persist IDs
    await prisma.division.update({
      where: { id: div.id },
      data: { discordRoleId: roleId, discordChannelId: channelId },
    });
  }

  revalidatePath("/admin/seasons");
}
