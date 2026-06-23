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

  const running = await prisma.activityScan.findFirst({
    where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (running) {
    revalidatePath("/admin/activity");
    return;
  }

  const scan = await prisma.activityScan.create({
    data: { seasonId: season.id, startedById: user.discordId },
  });
  await enqueueActivityScan(scan.id);
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
