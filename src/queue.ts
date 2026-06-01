// Durable job queue for fire-and-forget Discord work. Survives crashes
// (jobs persist in Postgres), retries 429s automatically via discord.js
// inside the handler, and decouples high-volume operations from the
// triggering request.
//
// Current jobs:
//   notify.dm           — send a DM to a user. Used by the next-season
//                         blast so a crash mid-blast doesn't lose subs.
//   bootstrap.division  — full per-division setup: role + member-roles
//                         + private channel + welcome post. Enqueued
//                         one per division by the web admin action so
//                         a 19-division season doesn't time out the
//                         browser tab.
//
// More can be added by registering another work() handler in initQueue().
// All web-side enqueues happen via web/lib/queue.ts which talks to the
// same Postgres tables; this file owns the workers.

import { PgBoss, type Job } from "pg-boss";
import { archiveStaleThreads } from "./archive-stale-threads.js";
import { detectCurrentBmpSeason, fetchPlayerStats } from "./balatromp.js";
import { spawnDisputeThread } from "./dispute-thread.js";
import { resolveBackupChannelId } from "./backup-channel.js";
import { resolveDevopsChannelId } from "./devops-channel.js";
import { resolveBotCommandsChannelId } from "./bot-commands-channel.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { checkQueueStalls } from "./devops-alarm.js";
import { tryGetDiscordClient } from "./discord.js";
import {
  addGuildMemberRole,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
  removeGuildMemberRole as removeGuildMemberRoleViaBot,
} from "./discord-helpers.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { buildLeagueExport, exportFilename, serializeExport } from "./league-export.js";
import { postPendingReport } from "./report-flow.js";
import { autoConfirmReport } from "./report-auto-confirm.js";
import { getLeagueSettings } from "./league-settings.js";
import { ChannelType, AttachmentBuilder } from "discord.js";

let boss: PgBoss | null = null;

export async function initQueue(): Promise<void> {
  if (boss) return;
  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Pg-boss installs its schema on first start. Idempotent. Retention
    // is per-queue in v12; defaults (7d on completed, 14d in created/
    // retry state) are fine for our scale — pgboss.archive stays small.
    schema: "pgboss",
  });
  boss.on("error", (err: Error) => console.warn("[pg-boss] error:", err));
  await boss.start();
  // pg-boss v12 no longer auto-creates queues on first work()/send(). Have
  // to declare every queue we use here; createQueue is idempotent so safe
  // to run every boot.
  await boss.createQueue("notify.dm");
  await boss.createQueue("bootstrap.division");
  await boss.createQueue("snapshot.mmr");
  await boss.createQueue("refresh.active-mmrs");
  await boss.createQueue("backup.league");
  await boss.createQueue("report.post-pending");
  await boss.createQueue("report.auto-confirm");
  await boss.createQueue("archive.stale-threads");
  await boss.createQueue("devops.queue-stall-check");
  await boss.createQueue("cleanup.strip-role");
  await boss.createQueue("award.champion-role");
  await boss.createQueue("dispute.spawn-thread");
  console.log("[pg-boss] queue started");

  // Worker: send a DM to one user. Retried automatically on failure.
  await boss.work<DmJob>(
    "notify.dm",
    { batchSize: 5, pollingIntervalSeconds: 2 },
    async (jobs: Job<DmJob>[]) => {
      const results = await Promise.allSettled(
        jobs.map(async (job: Job<DmJob>) => {
          const { discordId, content } = job.data;
          const client = tryGetDiscordClient();
          if (!client) throw new Error("Discord client not ready");
          const user = await client.users.fetch(discordId);
          await user.send({ content });
        }),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(`[notify.dm] ${failures.length}/${jobs.length} failed:`, failures);
      }
    },
  );

  // Worker: bootstrap one division's Discord presence. Bounded parallelism
  // (batchSize 2) so a 19-division season doesn't slam Discord all at once
  // but still finishes in seconds, not minutes.
  await boss.work<BootstrapDivisionJob>(
    "bootstrap.division",
    { batchSize: 2, pollingIntervalSeconds: 2 },
    async (jobs: Job<BootstrapDivisionJob>[]) => {
      for (const job of jobs) {
        await bootstrapDivision(job.data);
      }
    },
  );

  // Worker: scrape one player's stats from balatromp.com and store a
  // PlayerMmrSnapshot row. Serial (batchSize 1) so a 50-player signup
  // burst doesn't slam balatromp's CDN — drains at ~1 req/3sec. Always
  // writes a row, even on parse/fetch failure — fetchError captures
  // what went wrong so admin can see "no balatromp account" vs "page
  // changed" vs "timeout".
  await boss.work<MmrSnapshotJob>(
    "snapshot.mmr",
    { batchSize: 1, pollingIntervalSeconds: 3 },
    async (jobs: Job<MmrSnapshotJob>[]) => {
      for (const job of jobs) {
        await snapshotPlayerMmr(job.data);
      }
    },
  );

  // Worker: periodic re-snapshot of CURRENT participants only — open
  // signup round signups, or (when no signups are open) active season
  // members. Past seasons are static; their snapshots are frozen on
  // purpose for historical reference, so we never re-fetch them.
  await boss.work(
    "refresh.active-mmrs",
    { batchSize: 1 },
    async () => {
      // Refresh BMP current-season detection before fanning out snapshots
      // so the per-player captures use the latest 'current' label without
      // admin intervention when BMP launches a new season.
      await ensureBmpCurrentSeasonDetected();
      await refreshActiveMmrs();
    },
  );
  // Daily at 12:00 UTC. Idempotent: schedule() upserts so calling on every
  // boot just keeps the cron expression in sync. With current participants
  // (~100 max) and snapshot.mmr at 1 req/3sec, a full refresh takes ~5 min
  // — gentle on balatromp's CDN.
  await boss.schedule("refresh.active-mmrs", "0 12 * * *");
  console.log("[pg-boss] scheduled refresh.active-mmrs @ 12:00 UTC daily");

  // One-shot at boot: detect BMP current season so first-deploy admin
  // doesn't have to set LeagueConfig manually. The cron handler runs
  // this again on each refresh so the config stays current going forward.
  ensureBmpCurrentSeasonDetected().catch((err) =>
    console.warn("[bmp] initial season detect failed:", err),
  );

  // Daily league backup: build JSON snapshot, post to bot-commands as
  // an attachment. Off-platform redundancy in case Railway's Postgres
  // loses data — admin scrolls back through bot-commands attachments
  // and picks the most recent before whatever broke.
  await boss.work("backup.league", { batchSize: 1 }, async () => {
    await runLeagueBackup();
  });
  // Daily at 06:00 UTC. Idempotent like the refresh schedule. File size
  // is tiny (~250KB at current scale) so 7x the volume of weekly is a
  // non-issue for Discord storage.
  await boss.schedule("backup.league", "0 6 * * *");
  console.log("[pg-boss] scheduled backup.league @ 06:00 UTC daily");

  // Worker: post the public PENDING report embed to #results. Used by
  // the web-side /me report flow which can't post directly. Discord
  // /report posts inline so it normally bypasses this queue.
  await boss.work<{ pairingId: string }>(
    "report.post-pending",
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        await postPendingReport(job.data.pairingId).catch((err) =>
          console.warn(`[report.post-pending] ${job.data.pairingId} failed:`, err),
        );
      }
    },
  );

  // Worker: 2-min auto-confirm. Both the inline /report path AND the
  // web report path enqueue this with startAfter 120s. Handler is a
  // no-op if the pairing already left PENDING (opponent confirmed,
  // admin overrode, etc).
  await boss.work<{ pairingId: string }>(
    "report.auto-confirm",
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        await autoConfirmReport(job.data.pairingId).catch((err) =>
          console.warn(`[report.auto-confirm] ${job.data.pairingId} failed:`, err),
        );
      }
    },
  );

  // Worker: sweep COMPLETE/CANCELLED MatchSession threads that the
  // inline closeMatchChannel() never finished. Discord has a 1000
  // active-thread soft cap; this keeps us from leaking into it when
  // a closure failed (bot restart, 5xx, permissions blip).
  await boss.work("archive.stale-threads", { batchSize: 1 }, async () => {
    await archiveStaleThreads();
  });
  // Hourly at :15 — offset from the other crons so they don't all
  // fire at once. Idempotent.
  await boss.schedule("archive.stale-threads", "15 * * * *");
  console.log("[pg-boss] scheduled archive.stale-threads @ :15 hourly");

  // Worker: strip ONE division role from ONE player. Fanned out by the
  // end-of-season cleanup admin action so a 100-player season doesn't
  // ddos Discord with serial role-remove calls. Idempotent — Discord
  // returns 404 if the player no longer has the role, which the helper
  // swallows.
  await boss.work<StripRoleJob>(
    "cleanup.strip-role",
    { batchSize: 3, pollingIntervalSeconds: 2 },
    async (jobs: Job<StripRoleJob>[]) => {
      for (const job of jobs) {
        const { guildId, discordId, roleId } = job.data;
        await removeGuildMemberRoleViaBot(guildId, discordId, roleId);
      }
    },
  );

  // Worker: award one division-champion role. Creates the role if it
  // doesn't exist yet, assigns to the winning player, persists the
  // role id on Division.championRoleId so re-runs are idempotent.
  // Color is hardcoded gold (0xFFD700). Mentionable so winners can
  // ping the role to flex.
  await boss.work<AwardChampionRoleJob>(
    "award.champion-role",
    { batchSize: 2, pollingIntervalSeconds: 2 },
    async (jobs: Job<AwardChampionRoleJob>[]) => {
      for (const job of jobs) {
        await awardChampionRole(job.data);
      }
    },
  );

  // Worker: scan pg-boss for jobs stuck in 'created' state >5min and
  // post to #devops. Pings DEVOPS role bindings ONLY — distinct from
  // league admin/helper. Hooking it as a pg-boss job means if pg-boss
  // itself is unhealthy enough that this check can't run, we'd notice
  // the check itself stops firing (silence = also a signal).
  await boss.work("devops.queue-stall-check", { batchSize: 1 }, async () => {
    await checkQueueStalls();
  });
  // Every 5 minutes. Threshold is 5min so first alert lands 5–10min
  // after a stall starts. Cooldown inside the handler suppresses
  // repeats per queue.
  await boss.schedule("devops.queue-stall-check", "*/5 * * * *");
  console.log("[pg-boss] scheduled devops.queue-stall-check every 5min");

  // Worker: spawn a Discord helper-mediation thread for a disputed
  // pairing. Used by the web dispute flow (Discord button-driven
  // disputes call spawnDisputeThread inline). Idempotent on
  // Pairing.disputeThreadId — re-runs no-op once a thread exists.
  await boss.work<{ pairingId: string }>(
    "dispute.spawn-thread",
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        await spawnDisputeThread(job.data.pairingId).catch((err) =>
          console.warn(`[dispute.spawn-thread] ${job.data.pairingId}:`, err),
        );
      }
    },
  );
}

export async function enqueueDisputeSpawnThread(pairingId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("dispute.spawn-thread", { pairingId }, { retryLimit: 2 });
}

export async function enqueueDm(job: DmJob): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("notify.dm", job, { retryLimit: 3, retryBackoff: true });
}

export async function enqueueReportPostPending(pairingId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("report.post-pending", { pairingId }, { retryLimit: 2 });
}

export async function enqueueReportAutoConfirm(pairingId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  const settings = await getLeagueSettings();
  await boss.send(
    "report.auto-confirm",
    { pairingId },
    { startAfter: settings.reportAutoConfirmSeconds, retryLimit: 2 },
  );
}

// Build snapshot, post to the bot-commands channel as a file. Shared
// between the weekly cron and the /admin export-results command.
export async function runLeagueBackup(): Promise<{
  postedTo: string | null;
  fileSize: number;
  filename: string;
}> {
  const data = await buildLeagueExport();
  const buf = serializeExport(data);
  const filename = exportFilename();
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[backup.league] Discord client not ready; skipping post");
    return { postedTo: null, fileSize: buf.length, filename };
  }
  // Resolution: explicit BackupChannelId override (env or LeagueConfig)
  // → devops channel (default) → bot-commands (last-ditch fallback).
  // Backups land in the devops channel by default so we don't have to
  // maintain a separate staff-private channel just for weekly JSON
  // attachments — devops is already staff-only and gets bot output
  // anyway. If admin wants backups split out, they set BackupChannelId.
  const channelId =
    (await resolveBackupChannelId()) ??
    (await resolveDevopsChannelId()) ??
    (await resolveBotCommandsChannelId());
  if (!channelId) {
    console.warn("[backup.league] no destination channel resolved; skipping post");
    return { postedTo: null, fileSize: buf.length, filename };
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.warn(`[backup.league] channel ${channelId} not a text channel`);
      return { postedTo: null, fileSize: buf.length, filename };
    }
    const attachment = new AttachmentBuilder(buf, { name: filename });
    await channel.send({
      content: `📦 Weekly league backup — ${data.seasons.length} seasons, ${data.players.length} players. Source of truth if Railway eats itself.`,
      files: [attachment],
    });
    return { postedTo: channelId, fileSize: buf.length, filename };
  } catch (err) {
    console.warn("[backup.league] post failed:", err);
    return { postedTo: null, fileSize: buf.length, filename };
  }
}

// Re-snapshot every CURRENT participant — either everyone in the open
// signup round, or (if no signups are open) every active member of the
// active season. Past-season players are never re-fetched: their
// snapshots are frozen by design for historical seeding reference.
async function refreshActiveMmrs(): Promise<void> {
  if (!boss) return;
  // Open signups take priority — players in this state are about to need
  // their MMR for build-season, so freshness matters more here.
  const openRound = await prisma.signupRound.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
    include: {
      signups: { where: { withdrawn: false }, select: { discordId: true } },
    },
  });
  if (openRound) {
    const seasonId = openRound.resultingSeasonId ?? null;
    for (const s of openRound.signups) {
      await boss.send("snapshot.mmr", { discordId: s.discordId, seasonId }, { retryLimit: 2 });
    }
    console.log(`[refresh.active-mmrs] queued ${openRound.signups.length} for open round ${openRound.id}`);
    return;
  }
  // Fall back to active season members.
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      divisions: {
        include: {
          members: {
            where: { status: "ACTIVE" },
            include: { player: { select: { discordId: true } } },
          },
        },
      },
    },
  });
  if (!activeSeason) {
    console.log("[refresh.active-mmrs] no open signups and no active season — skipping");
    return;
  }
  // Dedup by discordId — a player shouldn't be in two divisions but be defensive.
  const seen = new Set<string>();
  for (const div of activeSeason.divisions) {
    for (const m of div.members) {
      if (seen.has(m.player.discordId)) continue;
      seen.add(m.player.discordId);
      await boss.send(
        "snapshot.mmr",
        { discordId: m.player.discordId, seasonId: activeSeason.id },
        { retryLimit: 2 },
      );
    }
  }
  console.log(`[refresh.active-mmrs] queued ${seen.size} for active season ${activeSeason.id}`);
}

async function snapshotPlayerMmr({ discordId, seasonId }: MmrSnapshotJob): Promise<void> {
  const player = await prisma.player.findUnique({ where: { discordId } });
  // Resolve the BMP current-season tag from LeagueConfig. Auto-detected
  // on bot startup + daily refresh; admin can also override manually.
  const currentBmpSeason = await getConfig(LeagueConfigKey.BmpCurrentSeason);
  // Always capture the current state.
  await fetchAndStore(discordId, player?.id ?? null, seasonId, currentBmpSeason);

  if (!currentBmpSeason) return;
  const currentN = parseSeasonNumber(currentBmpSeason);
  if (!currentN || currentN <= 1) return;

  // Backfill any missing historical BMP seasons (season1 through current-1)
  // we don't already have a successful row for. Self-terminates per player:
  // after the first refresh that backfills, future refreshes find every
  // past season already captured and skip them. Past BMP seasons are
  // frozen so one successful capture per (player, season) is forever.
  const existing = await prisma.playerMmrSnapshot.findMany({
    where: {
      discordId,
      bmpSeason: { not: null },
      rankedMmr: { not: null },
    },
    select: { bmpSeason: true },
    distinct: ["bmpSeason"],
  });
  const haveSeasons = new Set(existing.map((e) => e.bmpSeason).filter(Boolean));

  for (let n = 1; n < currentN; n++) {
    const tag = `season${n}`;
    if (haveSeasons.has(tag)) continue;
    await fetchAndStore(discordId, player?.id ?? null, seasonId, tag);
  }

  // Opt-in force re-capture of previous season (and only previous — for
  // wider re-captures, admin can null out the snapshots manually). Kept
  // around for cases where the API briefly returned bad data we want to
  // overwrite. Default off — backfill above handles new players.
  if ((await getConfig(LeagueConfigKey.BmpCapturePreviousSeason)) === "true") {
    const prev = previousBmpSeason(currentBmpSeason);
    if (prev) await fetchAndStore(discordId, player?.id ?? null, seasonId, prev);
  }
}

// "season6" → 6. Returns null if input isn't a recognized season pattern.
function parseSeasonNumber(s: string): number | null {
  const m = /^season(\d+)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

// Single fetch + insert. Splitting out so snapshotPlayerMmr can call it
// twice (current + previous BMP season) without duplicating the wiring.
async function fetchAndStore(
  discordId: string,
  playerId: string | null,
  seasonId: string | null,
  bmpSeason: string | null,
): Promise<void> {
  const { stats, rawJson, error } = await fetchPlayerStats(discordId, bmpSeason);
  await prisma.playerMmrSnapshot.create({
    data: {
      discordId,
      playerId,
      seasonId,
      bmpSeason,
      rankedMmr: stats?.rankedMmr ?? null,
      rankedTier: stats?.rankedTier ?? null,
      totalGames: stats?.totalGames ?? null,
      winRatePct: stats?.winRatePct ?? null,
      peakMmr: stats?.peakMmr ?? null,
      wins: stats?.wins ?? null,
      losses: stats?.losses ?? null,
      peakStreak: stats?.peakStreak ?? null,
      leaderboardRank: stats?.leaderboardRank ?? null,
      // Only keep the blob on failures — successful snapshots don't
      // need a JSON body per player taking up space.
      rawHtml: error ? rawJson : null,
      fetchError: error,
    },
  });
}

// Detect BMP's current season from their leaderboards page and update
// LeagueConfig.BmpCurrentSeason if it changed. Best-effort — failures
// leave the existing config alone. Called at bot boot + at the start
// of each daily refresh cron so per-player snapshots always use the
// latest 'current' season label without admin intervention.
async function ensureBmpCurrentSeasonDetected(): Promise<void> {
  const detected = await detectCurrentBmpSeason();
  if (!detected) return;
  const stored = await getConfig(LeagueConfigKey.BmpCurrentSeason);
  if (stored === detected) return;
  await setConfig(LeagueConfigKey.BmpCurrentSeason, detected, "auto-detect");
  console.log(`[bmp] current season ${stored ? `updated ${stored} → ${detected}` : `set to ${detected}`}`);
}

// "season6" → "season5". Returns null if input isn't a recognized
// season pattern or if there's no previous (season1 → null).
function previousBmpSeason(s: string): string | null {
  const m = /^season(\d+)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 1) return null;
  return `season${n - 1}`;
}

interface DmJob {
  discordId: string;
  content: string;
}

interface StripRoleJob {
  guildId: string;
  discordId: string;
  roleId: string;
}

interface AwardChampionRoleJob {
  guildId: string;
  divisionId: string;
  winnerDiscordId: string;
  roleName: string;
}

// Create-or-reuse the per-division champion role + assign to the winner.
// Idempotent on division.championRoleId — if a role id is already
// persisted, we just re-assign rather than creating a duplicate. If the
// role was manually deleted, we'd see an error on assign + create a
// fresh one; admin re-runs the action to recover.
async function awardChampionRole({
  guildId,
  divisionId,
  winnerDiscordId,
  roleName,
}: AwardChampionRoleJob): Promise<void> {
  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (!division) return;
  let roleId = division.championRoleId;
  if (!roleId) {
    const created = await createGuildRole(guildId, roleName, {
      color: 0xffd700, // gold
      mentionable: true,
    });
    if (!created) {
      console.warn(`[award.champion-role] failed to create role for division ${divisionId}`);
      return;
    }
    roleId = created.id;
    await prisma.division.update({ where: { id: divisionId }, data: { championRoleId: roleId } });
  }
  const assigned = await addGuildMemberRole(guildId, winnerDiscordId, roleId);
  if (!assigned) {
    console.warn(`[award.champion-role] role assign failed for ${winnerDiscordId} on division ${divisionId}`);
  }
}

interface BootstrapDivisionJob {
  divisionId: string;
  guildId: string;
}

interface MmrSnapshotJob {
  // Canonical key — works even when no Player row exists yet (new signups
  // captured at signup-close, before build-season materializes Players).
  discordId: string;
  // Null = ad-hoc capture not tied to a season (admin refresh of a player).
  seasonId: string | null;
}

// Set up role + member-roles + private channel + welcome post for one
// division. Idempotent — re-runs check what's already done via the IDs
// persisted back on the Division row, so a partial failure plus retry
// picks up where it left off rather than duplicating roles/channels.
async function bootstrapDivision({ divisionId, guildId }: BootstrapDivisionJob): Promise<void> {
  const div = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      season: true,
      tier: true,
      members: { where: { status: "ACTIVE" }, include: { player: true } },
    },
  });
  if (!div) {
    console.warn(`[bootstrap.division] ${divisionId} not found, skipping`);
    return;
  }
  if (div.discordRoleId && div.discordChannelId) return; // already done
  if (div.members.length === 0) return;

  const parentId = div.season.discordCategoryId ?? undefined;
  const staffBindings = await prisma.roleBinding.findMany({
    where: { tier: { in: ["ADMIN", "HELPER"] } },
  });
  const staffRoleIds = staffBindings.map((b) => b.discordRoleId);

  // 1) Role — persist immediately so a crash before channel-create doesn't
  // strand the role on a re-run.
  let roleId = div.discordRoleId;
  if (!roleId) {
    const role = await createGuildRole(guildId, `${div.season.name} · ${div.name}`, { mentionable: true });
    if (!role) throw new Error(`createGuildRole failed for division ${div.id}`);
    roleId = role.id;
    await prisma.division.update({ where: { id: div.id }, data: { discordRoleId: roleId } });
  }

  // 2) Assign role to all members. addGuildMemberRole is idempotent on
  // Discord's side so re-runs are safe.
  for (const m of div.members) {
    await addGuildMemberRole(guildId, m.player.discordId, roleId);
  }

  // 3) Channel — falls back to top level if category is full (50-channel cap)
  let channelId = div.discordChannelId;
  if (!channelId) {
    const channelName = div.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let channel = await createGuildTextChannel(guildId, channelName, {
      parentId,
      topic: `${div.season.name} — ${div.tier.name} tier, division ${div.name}`,
      visibleToRoleIds: [roleId, ...staffRoleIds],
    });
    if (!channel && parentId) {
      console.warn(`[bootstrap.division] ${channelName} couldn't fit under category — falling back to top level`);
      channel = await createGuildTextChannel(guildId, channelName, {
        topic: `${div.season.name} — ${div.tier.name} tier, division ${div.name} (overflow)`,
        visibleToRoleIds: [roleId, ...staffRoleIds],
      });
    }
    if (!channel) throw new Error(`createGuildTextChannel failed for division ${div.id}`);
    channelId = channel.id;

    // 4) Welcome message — full onboarding for everyone in this division
    const mentions = div.members.map((m) => `<@${m.player.discordId}>`).join(" ");
    const memberList = div.members
      .map((m, i) => `${i + 1}. <@${m.player.discordId}>`)
      .join("\n");
    // Each player plays (N-1) matches — one against every other member.
    // Total matches in the division is N*(N-1)/2 for context.
    const matchesPerPlayer = div.members.length - 1;
    const totalMatchesInDivision = (div.members.length * (div.members.length - 1)) / 2;
    const welcome = [
      `# 🃏 Welcome to ${div.name}`,
      `_${div.season.name} · ${div.tier.name} tier_`,
      ``,
      mentions,
      ``,
      `**Your opponents (${div.members.length}):**`,
      memberList,
      ``,
      `**What to do**`,
      `• Play **every other person** in this list once — best-of-2 (**${matchesPerPlayer} matches per player**, ${totalMatchesInDivision} total in this division).`,
      `• Schedule in this channel. DMs work too.`,
      `• Use \`/start-match @opponent\` for the guided ban/pick flow (the bot picks the deck/stake for you), OR just play in Balatro and use \`/report @opponent result:2-0|1-1|0-2\` to log it.`,
      ``,
      `**Standings + your schedule:** <https://www.balatroleague.com/divisions/${div.id}>`,
      ``,
      `Good luck. 🎴`,
    ].join("\n");
    // silent=true: members still see the channel show up (they got the role)
    // and the welcome message is there for reference when they visit, but no
    // ping fires for the @mentions inside. Bootstrap shouldn't blast everyone
    // — players discover the channel via their sidebar / the role, not a ping.
    await postChannelMessage(channelId, welcome, { silent: true });
  }

  await prisma.division.update({
    where: { id: div.id },
    data: { discordRoleId: roleId, discordChannelId: channelId },
  });
}
