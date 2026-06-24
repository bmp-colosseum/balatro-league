"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { enqueueActivityScan, enqueueDm, enqueueRosterCheckin } from "@/lib/queue";
import { buildCheckinMessage } from "@/lib/checkin-message";
import { loadActivityData } from "@/lib/loaders/activity";
import type { ActionResult } from "@/lib/action-result";

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

// Admin opt-out toggle: flip a player's reminder opt-out so they're skipped by
// the check-in send (and other nudge DMs). Reversible.
export async function setCheckinOptOut(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const optOut = String(formData.get("optOut")) === "true";
  if (!playerId) return;
  await prisma.player.update({ where: { id: playerId }, data: { signupReminderOptOut: optOut } });
  revalidatePath("/admin/activity");
}

// Send the real check-in DMs to the flagged (silent) players. The bot worker
// skips anyone opted out or already asked/answered, so this is safe to re-run.
export async function sendCheckinDms(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const season = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!season) return { ok: false, message: "No active season." };
  const data = await loadActivityData();
  // Match the page's "sendable" set so the reported count is honest (the worker
  // also skips opt-outs / already-asked, but we filter here for an accurate N).
  const ids = (data.ghosts ?? [])
    .filter((g) => !g.optedOut && (g.checkinStatus === null || g.checkinStatus === "dm-failed"))
    .map((g) => g.playerId);
  if (ids.length === 0) {
    revalidatePath("/admin/activity");
    return { ok: false, message: "Nobody to message — everyone flagged is opted out or already asked." };
  }
  await enqueueRosterCheckin({ playerIds: ids, seasonId: season.id });
  revalidatePath("/admin/activity");
  return {
    ok: true,
    message: `Queued check-in DMs to ${ids.length} player${ids.length === 1 ? "" : "s"} — they'll go out in a few seconds. Refresh to watch the Check-in column flip to "asked".`,
  };
}

// DM the calling admin a TEST of the check-in message, so they can see exactly
// what players will get (and confirm the jump link is clickable in a DM). Uses
// their own division when they're in one, else sample text.
export async function sendTestCheckin(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, scheduledEndAt: true },
  });
  if (!season) return { ok: false, message: "No active season." };

  const member = await prisma.divisionMember.findFirst({
    where: { seasonId: season.id, status: "ACTIVE", player: { discordId: user.discordId } },
    select: {
      division: { select: { name: true, discordChannelId: true } },
      player: { select: { displayName: true } },
    },
  });
  const supportCfg = await prisma.leagueConfig.findUnique({
    where: { key: "support_channel_id" },
    select: { value: true },
  });

  const guildId = process.env.DISCORD_GUILD_ID;
  const jump = (channelId: string | null | undefined) =>
    guildId && channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null;

  const content = buildCheckinMessage({
    name: member?.player.displayName ?? "there",
    divisionName: member?.division.name ?? "your division",
    divisionChannelUrl: jump(member?.division.discordChannelId),
    supportChannelUrl: jump(supportCfg?.value),
    seasonEndsAt: season.scheduledEndAt,
    isTest: true,
  });

  await enqueueDm({ discordId: user.discordId, content });
  revalidatePath("/admin/activity");
  return { ok: true, message: "Test DM sent to you — check your Discord DMs (arrives in a few seconds)." };
}
