"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import {
  ensureGuildCategory,
  lockChannelForEveryone,
  setChannelParent,
} from "@/lib/discord";
import { enqueueBootstrapDivision } from "@/lib/queue";

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
// The web action just ensures the season category exists, then enqueues
// one bootstrap.division job per division. The bot's pg-boss worker
// (src/queue.ts) does the heavy lifting:
//   - Create role + assign to members
//   - Create private channel under the season category
//   - Post welcome message
//   - Persist discordRoleId + discordChannelId back on the Division row
//
// This avoids a multi-minute browser-tab-blocking action on a 19-division
// season, and survives crashes mid-bootstrap. Idempotent per-division on
// the worker side (skips divisions that already have both ids set).
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
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          discordRoleId: true,
          discordChannelId: true,
          _count: { select: { members: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  if (!season) return;

  // If admin didn't set a category id, auto-create '🃏 Season Name' so each
  // season gets a clean home (instead of all divisions dumped in #general
  // or whatever the bot's nearest category is). Done sync so the worker
  // jobs see the parent id immediately.
  if (!season.discordCategoryId) {
    const cat = await ensureGuildCategory(guildId, `🃏 ${season.name}`);
    if (cat) {
      await prisma.season.update({
        where: { id: season.id },
        data: { discordCategoryId: cat.id },
      });
    }
  }

  // Enqueue one job per division that isn't already fully set up. Empty
  // divisions are skipped the same way the old sync loop skipped them.
  let queued = 0;
  for (const div of season.divisions) {
    if (div.discordRoleId && div.discordChannelId) continue;
    if (div._count.members === 0) continue;
    await enqueueBootstrapDivision({ divisionId: div.id, guildId });
    queued++;
  }
  console.log(`[bootstrap] queued ${queued} division bootstrap jobs for season ${season.name}`);

  revalidatePath("/admin/seasons");
  revalidatePath(`/admin/seasons/${id}`);
}

// Close out a season's Discord presence: lock every division channel
// (deny SEND_MESSAGES on @everyone) and move them to a '📦 Season X
// Archive' category so the active categories aren't cluttered with
// dead seasons. History stays readable.
export async function archiveSeasonChannels(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("DISCORD_GUILD_ID not set; skipping channel archive");
    return;
  }

  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      divisions: {
        where: { discordChannelId: { not: null } },
      },
    },
  });
  if (!season) return;

  const archiveCategory = await ensureGuildCategory(guildId, `📦 ${season.name} Archive`);
  if (!archiveCategory) {
    console.warn(`[archive] couldn't create archive category for ${season.name}`);
    return;
  }

  for (const div of season.divisions) {
    if (!div.discordChannelId) continue;
    // Lock the channel (read-only) then move it under the archive category.
    // Best-effort — failures don't abort the loop so we archive what we can.
    await lockChannelForEveryone(guildId, div.discordChannelId).catch(() => {});
    await setChannelParent(div.discordChannelId, archiveCategory.id).catch(() => {});
  }

  revalidatePath("/admin/seasons");
  revalidatePath(`/admin/seasons/${id}`);
}
