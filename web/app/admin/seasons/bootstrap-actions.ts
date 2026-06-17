"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import {
  ensureGuildCategory,
  lockChannelForEveryone,
  setChannelParent,
} from "@/lib/discord";
import { enqueueAwardChampionRole, enqueueStripDivisionRole } from "@/lib/queue";
import { computeStandings } from "@/lib/standings";
import { formatSeasonLabel } from "@/lib/format-season";
import { runSeasonDiscordBootstrap } from "@/lib/season-discord-bootstrap";

async function getSeasonLabelOrEmpty(id: string): Promise<string> {
  const s = await prisma.season.findUnique({
    where: { id },
    select: { number: true, subtitle: true },
  });
  return s ? formatSeasonLabel(s) : "";
}

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

// Save (or clear) per-season override for the results-announcement webhook
// URL. Empty input clears the override — the season falls back to global
// LeagueConfig / env.
export async function setSeasonResultsWebhook(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("resultsWebhookUrl") ?? "").trim();
  if (!id) return;
  // Validate webhook URL shape only when non-empty. Discord webhook URLs
  // look like: https://discord.com/api/webhooks/<id>/<token>
  if (raw !== "" && !/^https:\/\/(canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(raw)) {
    throw new Error("Doesn't look like a Discord webhook URL");
  }
  await prisma.season.update({
    where: { id },
    data: { resultsWebhookUrl: raw === "" ? null : raw },
  });
  revalidatePath(`/seasons/${id}`);
}

// Save (or clear) per-season override for the results channel id used by
// the bot-REST fallback path (when no webhook is configured).
export async function setSeasonResultsChannel(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("resultsChannelId") ?? "").trim();
  if (!id) return;
  if (raw !== "" && !/^\d{17,20}$/.test(raw)) {
    throw new Error("Channel ID should be a numeric Discord snowflake");
  }
  await prisma.season.update({
    where: { id },
    data: { resultsChannelId: raw === "" ? null : raw },
  });
  revalidatePath(`/seasons/${id}`);
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
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const queued = await runSeasonDiscordBootstrap(id);
  if (queued === null) return;
  const seasonLabel = await getSeasonLabelOrEmpty(id);
  console.log(`[bootstrap] queued ${queued} division bootstrap jobs for season ${seasonLabel}`);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.bootstrap-discord",
    targetType: "Season",
    targetId: id,
    summary: `Bootstrapping Discord for "${seasonLabel}" (${queued} divisions queued)`,
    metadata: { queuedCount: queued },
  });

  revalidatePath("/admin/seasons");
  revalidatePath(`/seasons/${id}`);
}

// Re-home a season's Discord presence to the CURRENT guild (DISCORD_GUILD_ID)
// — for moving the league to a new server mid-season. Gameplay data is never
// touched; only the stale guild-specific links are cleared, then the season is
// re-bootstrapped into the new guild:
//   1. Clear Season.discordCategoryId + every division's discordChannelId /
//      discordRoleId / championRoleId (they point at the OLD server).
//   2. runSeasonDiscordBootstrap → re-creates the season category, each
//      division's channel + role, and re-assigns the role to members (who
//      must already be in the new server).
//
// Prereqs (do these first): set DISCORD_GUILD_ID to the new guild, invite the
// bot + players there, and run /league setup in the new server (re-creates the
// league channels + staff roles/bindings). OWNER-only + typed confirm because
// running it on the WRONG (still-valid) guild would orphan the live channels.
export async function rehomeSeasonDiscord(formData: FormData) {
  const { user } = await requireOwner();
  const id = String(formData.get("id") ?? "");
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (!id) return;
  if (confirm !== "REHOME") {
    redirect(`/admin/seasons?err=${encodeURIComponent('Type REHOME to confirm re-homing this season.')}`);
  }
  const season = await prisma.season.findUnique({ where: { id }, select: { id: true, number: true, subtitle: true } });
  if (!season) return;

  // 1) Clear the stale guild-specific links (NOT gameplay).
  await prisma.season.update({ where: { id }, data: { discordCategoryId: null } });
  const cleared = await prisma.division.updateMany({
    where: { seasonId: id },
    data: { discordChannelId: null, discordRoleId: null, championRoleId: null },
  });

  // 2) Re-bootstrap into the current guild (now that the ids are clear, none
  // are skipped). Recreates category + division channels/roles + member roles.
  const queued = await runSeasonDiscordBootstrap(id);

  const seasonLabel = formatSeasonLabel(season);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.rehome-discord",
    targetType: "Season",
    targetId: id,
    summary: `Re-homed "${seasonLabel}" to the current guild — cleared ${cleared.count} divisions, queued ${queued ?? 0} re-bootstraps`,
    metadata: { divisionsCleared: cleared.count, queued: queued ?? 0 },
  });
  revalidatePath("/admin/seasons");
  revalidatePath(`/seasons/${id}`);
}

// Close out a season's Discord presence: lock every division channel
// (deny SEND_MESSAGES on @everyone) and move them to a '📦 Season X
// Archive' category so the active categories aren't cluttered with
// dead seasons. History stays readable.
export async function archiveSeasonChannels(formData: FormData) {
  const { user } = await requireAdmin();
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

  const seasonLabel = formatSeasonLabel(season);
  const archiveCategory = await ensureGuildCategory(guildId, `📦 ${seasonLabel} Archive`);
  if (!archiveCategory) {
    console.warn(`[archive] couldn't create archive category for ${seasonLabel}`);
    return;
  }

  for (const div of season.divisions) {
    if (!div.discordChannelId) continue;
    // Lock the channel (read-only) then move it under the archive category.
    // Best-effort — failures don't abort the loop so we archive what we can.
    await lockChannelForEveryone(guildId, div.discordChannelId).catch(() => {});
    await setChannelParent(div.discordChannelId, archiveCategory.id).catch(() => {});
  }
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.archive-channels",
    targetType: "Season",
    targetId: id,
    summary: `Archived Discord channels for "${seasonLabel}" (${season.divisions.length} channels)`,
    metadata: { channelCount: season.divisions.length, archiveCategoryId: archiveCategory.id },
  });

  revalidatePath("/admin/seasons");
  revalidatePath(`/seasons/${id}`);
}

// Strip the per-division role from every member of every division in a
// season. Fans out as one pg-boss job per (member, role) so a 100-player
// season doesn't slam Discord with serial role-remove calls. Each job
// is idempotent — if the player no longer has the role (left guild,
// already removed), the call is a no-op.
//
// Doesn't delete the roles themselves — leaves them around so the
// archived season channels still have a permission anchor. Admin can
// delete the orphan roles manually if they want a cleaner role list.
export async function stripSeasonDivisionRoles(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("DISCORD_GUILD_ID not set; skipping role cleanup");
    return;
  }
  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      divisions: {
        where: { discordRoleId: { not: null } },
        include: {
          members: {
            where: { status: "ACTIVE" },
            include: { player: { select: { discordId: true } } },
          },
        },
      },
    },
  });
  if (!season) return;
  let queued = 0;
  for (const div of season.divisions) {
    if (!div.discordRoleId) continue;
    for (const m of div.members) {
      await enqueueStripDivisionRole({
        guildId,
        discordId: m.player.discordId,
        roleId: div.discordRoleId,
      }).catch((err) =>
        console.warn(`[strip-role] enqueue failed for ${m.player.discordId} in ${div.id}:`, err),
      );
      queued++;
    }
  }
  const seasonLabel = formatSeasonLabel(season);
  console.log(`[strip-role] queued ${queued} role-remove jobs for season ${seasonLabel}`);
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "role.strip",
    targetType: "Season",
    targetId: id,
    summary: `Stripped division roles for "${seasonLabel}" (${queued} jobs queued)`,
    metadata: { queuedCount: queued },
  });
  revalidatePath(`/seasons/${id}`);
}

// Award per-division champion roles. For each division in the season:
//   1. Compute standings.
//   2. If row 0 and row 1 are tied (row 1 has tiedWithPrev = true), skip
//      that division — there's an unresolved tie at the top, no clear
//      champion yet. Re-running picks it up once the tie is resolved.
//   3. Otherwise: enqueue a job to create the role + assign to row 0.
//
// Idempotent at every layer:
//   - Division.championRoleId persists the created role's id so re-runs
//     don't create duplicates.
//   - addGuildMemberRole is idempotent — Discord no-ops if the player
//     already has the role.
// Run again after shootouts resolve to backfill the skipped divisions.
export async function awardSeasonChampionRoles(formData: FormData) {
  const { user } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("DISCORD_GUILD_ID not set; skipping champion roles");
    return;
  }
  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      divisions: {
        include: {
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          matches: {
            where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });
  if (!season) return;

  let queued = 0;
  let skipped = 0;
  for (const div of season.divisions) {
    if (div.members.length === 0) continue;
    const standings = computeStandings(div.members.map((m) => m.player), div.matches);
    if (standings.length === 0) continue;
    // Unresolved tie at #1 → skip. row[1].tiedWithPrev means rows 0+1
    // are tied on points/h2h/wins/draws, so no clear champion yet.
    if (standings[1]?.tiedWithPrev) {
      skipped++;
      continue;
    }
    const winner = standings[0];
    if (!winner) continue;
    // Persist the winner upfront so admin can see it on the season page
    // even if the role-assign Discord call is delayed by the queue.
    await prisma.division.update({
      where: { id: div.id },
      data: { championPlayerId: winner.player.id },
    });
    const roleName = `🏆 ${formatSeasonLabel(season)} ${div.name} Champion`;
    await enqueueAwardChampionRole({
      guildId,
      divisionId: div.id,
      winnerDiscordId: winner.player.discordId,
      roleName,
    }).catch((err) => console.warn(`[champion-roles] enqueue failed for ${div.id}:`, err));
    queued++;
  }
  const seasonLabel = formatSeasonLabel(season);
  console.log(
    `[champion-roles] queued ${queued} for season ${seasonLabel}` +
      (skipped > 0 ? `, skipped ${skipped} due to unresolved ties at #1` : ""),
  );
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "role.award-champion",
    targetType: "Season",
    targetId: id,
    summary: `Awarded champion roles for "${seasonLabel}" (${queued} awarded${skipped > 0 ? `, ${skipped} skipped due to ties` : ""})`,
    metadata: { awardedCount: queued, skippedDueToTies: skipped },
  });
  revalidatePath(`/seasons/${id}`);
}
