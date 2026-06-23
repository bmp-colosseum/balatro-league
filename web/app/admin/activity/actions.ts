"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { enqueueActivityScan, enqueueDm } from "@/lib/queue";
import { buildCheckinMessage } from "@/lib/checkin-message";
import { formatSeasonLabel } from "@/lib/format-season";

// Start an activity scan: create the ActivityScan row and enqueue the bot's
// activity.scan worker (which does the Discord message reads). No-op if one is
// already running.
export async function startActivityScan() {
  const { user } = await requireAdmin();
  const season = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!season) return;

  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const running = await prisma.activityScan.findFirst({
    where: { status: "RUNNING", startedAt: { gt: staleCutoff } },
  });
  if (running) {
    revalidatePath("/admin/activity");
    return;
  }
  // Clear stuck (stale) RUNNING scans so they don't block a fresh one.
  await prisma.activityScan.updateMany({
    where: { status: "RUNNING", startedAt: { lte: staleCutoff } },
    data: { status: "FAILED", error: "stale — superseded by a new scan", finishedAt: new Date() },
  });

  const scan = await prisma.activityScan.create({
    data: { seasonId: season.id, startedById: user.discordId },
  });
  await enqueueActivityScan(scan.id);
  revalidatePath("/admin/activity");
}

// Force-clear any RUNNING scan (e.g. one stuck because its worker never picked
// it up). Web-only — just flips the row's status, so it works even if the bot is
// down, and immediately unblocks starting a fresh scan.
export async function cancelActivityScan() {
  await requireAdmin();
  await prisma.activityScan.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILED", error: "Cancelled by admin", finishedAt: new Date() },
  });
  revalidatePath("/admin/activity");
}

// DM the calling admin a TEST of the check-in message, so they can see exactly
// what players will get (and confirm the jump link is clickable in a DM). Uses
// their own division when they're in one, else sample text.
export async function sendTestCheckin() {
  const { user } = await requireAdmin();
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, number: true, subtitle: true },
  });
  if (!season) return;

  const member = await prisma.divisionMember.findFirst({
    where: { seasonId: season.id, status: "ACTIVE", player: { discordId: user.discordId } },
    select: {
      division: { select: { name: true, discordChannelId: true } },
      player: { select: { displayName: true } },
    },
  });
  const queueCfg = await prisma.leagueConfig.findUnique({
    where: { key: "league_queue_channel_id" },
    select: { value: true },
  });

  const guildId = process.env.DISCORD_GUILD_ID;
  const jump = (channelId: string | null | undefined) =>
    guildId && channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null;

  const content = buildCheckinMessage({
    name: member?.player.displayName ?? "there",
    seasonLabel: formatSeasonLabel(season),
    divisionName: member?.division.name ?? "your division",
    divisionChannelUrl: jump(member?.division.discordChannelId),
    queueChannelUrl: jump(queueCfg?.value),
    isTest: true,
  });

  await enqueueDm({ discordId: user.discordId, content });
  revalidatePath("/admin/activity");
}
