// Core of season activation — flips the active season, audits it, kicks off the
// Discord bootstrap + announcement.
//
// SECURITY: this is a PLAIN module, deliberately NOT a "use server" action.
// As an exported action with no requireAdmin() it would be a network-reachable
// RPC endpoint (action-id is not an auth boundary), letting any caller
// deactivate the live season and forge the audit `actor`. Keeping it here means
// only the GUARDED entry points can run it: the activateSeason admin action
// (requireAdmin), the build-season API route (requireAdminToken), and e2e seed.
// Those entry points authenticate and supply a trustworthy `actor`.

import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { formatSeasonLabel } from "@/lib/format-season";
import { postChannelMessage } from "@/lib/discord";
import { enqueueLeagueInfoRefresh } from "@/lib/queue";
import { runSeasonDiscordBootstrap } from "@/lib/season-discord-bootstrap";
import { lockDivisionSchedules } from "@/lib/lock-schedule";

// Shared core of season activation. Flips isActive, deactivates any prior
// active season, clears scheduledStartAt on the target (so the cron doesn't
// re-fire), posts to the announcements channel if configured, audits it.
export async function performSeasonActivation(
  seasonId: string,
  actor: AuditActor,
  source: "manual" | "scheduled",
  opts: { skipDiscord?: boolean } = {},
): Promise<void> {
  const target = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!target) return;
  if (target.isActive) return; // idempotent — scheduled cron may race the manual button
  const prior = await prisma.season.findFirst({
    where: { isActive: true, NOT: { id: seasonId } },
  });
  if (prior) {
    await prisma.season.update({
      where: { id: prior.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  await prisma.season.update({
    where: { id: seasonId },
    data: { isActive: true, endedAt: null, scheduledStartAt: null },
  });
  recordAudit({
    actor,
    action: source === "scheduled" ? "season.activate-scheduled" : "season.activate",
    targetType: "Season",
    targetId: seasonId,
    summary: `Activated season "${formatSeasonLabel(target)}"${prior ? ` (deactivated "${formatSeasonLabel(prior)}")` : ""}${source === "scheduled" ? " — auto-triggered by scheduledStartAt" : ""}`,
    metadata: { previousActiveSeasonId: prior?.id ?? null, source },
  });
  // skipDiscord is for automation (seed/e2e) that flips a long chain of seasons
  // live without wanting to create+announce+tear-down Discord channels on every
  // one. Real activations always run the bootstrap.
  if (opts.skipDiscord) return;

  // Lock in each division's assigned-opponent schedule (pre-create the PENDING
  // match rows). Best-effort — activation still succeeds if it fails.
  await lockDivisionSchedules(seasonId).catch((err) =>
    console.warn("[season.activate] schedule lock failed:", err),
  );

  // Division channels can be turned off for a lightweight league: no
  // per-division channels/roles, matches happen in #bot-commands, results
  // announce to the central results channel, standings live on the web. When
  // the flag is set we skip ONLY the channel/role bootstrap — the season-start
  // announcement + #league-info refresh below still run.
  const divChannelsDisabled =
    (await prisma.leagueConfig.findUnique({
      where: { key: "division_channels_disabled" },
      select: { value: true },
    }))?.value === "true";
  if (!divChannelsDisabled) {
    // Auto-bootstrap Discord (per-division roles + channels). Idempotent +
    // best-effort: activation still succeeds if the enqueue fails. The
    // season-start announcement is NOT posted here — the LAST division bootstrap
    // job posts it, once every player has their League Player role (so the ping
    // reaches everyone).
    await runSeasonDiscordBootstrap(seasonId).catch((err) =>
      console.warn("[season.activate] Discord bootstrap enqueue failed:", err),
    );
  } else {
    // Lightweight league (no per-division channels/roles): no bootstrap jobs to
    // wait on, so announce right now (no League Player role exists to ping).
    await postSeasonStartAnnouncement(target.id, formatSeasonLabel(target)).catch((err) =>
      console.warn("[season.activate] announcement post failed:", err),
    );
  }

  // Refresh #league-info so the "Season N is live" block appears.
  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[season.activate] league-info refresh enqueue failed:", err),
  );
}

// Post a "season is now live" message to the configured announcements channel.
// No-op when the LeagueConfig key isn't set — admin can post manually.
async function postSeasonStartAnnouncement(seasonId: string, seasonLabel: string): Promise<void> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { leaguePlayerRoleId: true },
  });
  const row = await prisma.leagueConfig.findUnique({
    where: { key: "announcements_channel_id" },
    select: { value: true },
  });
  const channelId = row?.value ?? null;
  if (!channelId) return;
  // The ONE intentional ping: the per-season League Player role (everyone in
  // the season). Everything else the bot posts is ping-free.
  const roleId = season?.leaguePlayerRoleId ?? null;
  const ping = roleId ? `<@&${roleId}> ` : "";
  const content = `${ping}🃏 **${seasonLabel}** is live! Use \`/start-match @opponent\` to play. Good luck.`;
  await postChannelMessage(channelId, {
    content,
    allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
  });
}
