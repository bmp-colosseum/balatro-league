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
import { timedJobHandler } from "./metrics.js";
import { announceResult } from "./announce.js";
import { snapshotPlayerMmr, ensureBmpCurrentSeasonDetected, type MmrSnapshotJob } from "./mmr-snapshots.js";
import { runDisplayNameRefresh } from "./display-name-refresh.js";
import { runGuildMemberSync } from "./guild-member-sync.js";
import { spawnDisputeThread } from "./dispute-thread.js";
import { webUrl } from "./web-url.js";
import { prisma } from "./db.js";
import { refreshLeagueInfoPinned, refreshStandingsMessages } from "./channel-refresh.js";
import { env } from "./env.js";
import { checkQueueStalls } from "./devops-alarm.js";
import { postDevopsAlert } from "./devops-alert.js";
import { tryGetDiscordClient } from "./discord.js";
import { planSignupAskKickoff, sendOrRefreshAsk, planReminderTick } from "./signup/signup-reminders.js";

// Preflight for the announce worker: is a results destination configured at
// all (global webhook/channel via env or LeagueConfig)? Per-season overrides
// are a refinement on top; this catches the common "nobody set up #results"
// case so we alert ops instead of firing a flood of doomed requests.
async function announceDestinationConfigured(): Promise<boolean> {
  if ((env.RESULTS_WEBHOOK_URL ?? "").trim() || (env.RESULTS_CHANNEL_ID ?? "").trim()) return true;
  const rows = await prisma.leagueConfig.findMany({
    where: { key: { in: ["results_webhook_url", "results_channel_id"] } },
    select: { value: true },
  });
  return rows.some((r) => (r.value ?? "").trim().length > 0);
}

// Throttle the "results not configured" devops alert so a backlog doesn't
// spam the channel every poll.
let lastAnnounceConfigAlert = 0;
const ANNOUNCE_CONFIG_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
import {
  addGuildMemberRole,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  pinChannelMessage,
  findWelcomeMessageId,
  isUndeliverableDm,
  removeGuildMemberRole as removeGuildMemberRoleViaBot,
} from "./discord-helpers.js";
import { divisionControlsRow } from "./division-controls.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { formatSeasonLabel } from "./format-season.js";
import { postPendingReport } from "./report-flow.js";
import { autoConfirmReport } from "./report-auto-confirm.js";
import { getLeagueSettings } from "./league-settings.js";
import { runActivityScan } from "./activity-scan.js";
import { runRosterCheckin } from "./roster-checkin.js";
import { MODLOG_RETENTION_DAYS } from "./mod-log.js";
import { buildScheduleEmbed } from "./schedule-embed.js";
import { sanitizeName } from "./sanitize.js";

// One recipient of a roster-change schedule DM. "new" = the player just added;
// "opponent" = someone whose matchup now points at the replacement.
interface ScheduleChangeJob {
  playerId: string;
  role: "new" | "opponent";
  divisionName: string;
  departedName: string;
  newName: string;
}

let boss: PgBoss | null = null;

// Auto-instrument every work() registration with per-queue Prometheus job
// metrics (bot_job_duration_seconds / bot_jobs_total) so the ~10 workers
// below don't each need a manual wrap. work() is overloaded -- (name, handler)
// or (name, options, handler) -- so the wrapper keys off the trailing function
// argument and passes everything else through untouched.
function instrumentBossWork(b: PgBoss): void {
  const original = b.work.bind(b) as (name: string, ...rest: unknown[]) => Promise<string>;
  const wrapped = (name: string, ...rest: unknown[]): Promise<string> => {
    const last = rest[rest.length - 1];
    if (typeof last === "function") {
      rest[rest.length - 1] = timedJobHandler(name, last as (...args: unknown[]) => Promise<unknown>);
    }
    return original(name, ...rest);
  };
  b.work = wrapped as PgBoss["work"];
}

// Graceful stop for deploys: let in-flight jobs wind down, then close pg-boss so
// the next boot starts clean. Idempotent; bounded so we never overrun Docker's
// stop grace period.
export async function stopQueue(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  try {
    await b.stop({ timeout: 8000 }); // graceful is the default
  } catch (err) {
    console.warn("[pg-boss] stop failed:", err);
  }
}

export async function initQueue(): Promise<void> {
  if (boss) return;
  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Cap pg-boss's own connection pool. Default is ~10; with ~11
    // queue subscribers running concurrently the bot can easily eat
    // 10 connections just for pg-boss BEFORE Prisma even opens its
    // pool. Railway's free Postgres tier caps at ~22 connections
    // shared between bot, web, pg-boss, and any seed scripts —
    // budget pg-boss tight so the others have room.
    max: 3,
    // Pg-boss installs its schema on first start. Idempotent. Retention
    // is per-queue in v12; defaults (7d on completed, 14d in created/
    // retry state) are fine for our scale — pgboss.archive stays small.
    schema: "pgboss",
  });
  boss.on("error", (err: Error) => console.warn("[pg-boss] error:", err));
  instrumentBossWork(boss);
  await boss.start();
  // pg-boss v12 no longer auto-creates queues on first work()/send(). Have
  // to declare every queue we use here; createQueue is idempotent so safe
  // to run every boot.
  await boss.createQueue("notify.dm");
  await boss.createQueue("bootstrap.division");
  await boss.createQueue("snapshot.mmr");
  await boss.createQueue("refresh.active-mmrs");
  await boss.createQueue("report.post-pending");
  await boss.createQueue("report.auto-confirm");
  await boss.createQueue("devops.queue-stall-check");
  await boss.createQueue("cleanup.strip-role");
  await boss.createQueue("award.champion-role");
  await boss.createQueue("dispute.spawn-thread");
  await boss.createQueue("notify.announce-result");
  await boss.createQueue("league-info.refresh");
  await boss.createQueue("welcome.refresh");
  await boss.createQueue("standings.refresh");
  await boss.createQueue("refresh.display-names");
  await boss.createQueue("sync.guild-members");
  await boss.createQueue("signup.ask-kickoff");
  await boss.createQueue("signup.ask");
  await boss.createQueue("signup.reminder-tick");
  await boss.createQueue("activity.scan");
  await boss.createQueue("roster.checkin");
  await boss.createQueue("modlog.purge");
  await boss.createQueue("notify.schedule-change");

  // One-shot cleanup for retired queues. Their cron schedule rows +
  // accumulated jobs (no worker listens anymore) stay in pg-boss forever
  // unless we explicitly delete them — and the stall detector flags the
  // piled-up 'created' jobs as a false alarm. unschedule + deleteQueue are
  // idempotent, so keeping them on every boot is cheap insurance.
  //   archive.stale-threads — pre-5c2bc7c hourly cron, merged into
  //                           match-sweep's 60s interval.
  //   backup.league         — the daily Discord backup, removed in favor of
  //                           DB backups; its schedule kept enqueuing jobs
  //                           that triggered a "backup job stuck" alert.
  for (const retired of ["archive.stale-threads", "backup.league"]) {
    await boss.unschedule(retired).catch(() => {});
    await boss.deleteQueue(retired).catch(() => {});
  }

  console.log("[pg-boss] queue started");

  // Worker: send a DM to one user. batchSize 1 so a single failing send
  // can be retried on its own (throwing in a multi-job batch would re-run
  // the successful sends too and double-DM people). Transient failures
  // (client not ready yet, rate limits) throw → pg-boss retries. Permanent
  // ones (user has DMs off / blocked the bot, code 50007) are logged and
  // marked done so we don't retry a send that can never succeed.
  await boss.work<DmJob>(
    "notify.dm",
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<DmJob>[]) => {
      for (const job of jobs) {
        const { discordId, content, batchId, batchKind } = job.data;
        const client = tryGetDiscordClient();
        if (!client) {
          // Enqueued during boot before login — throw so it retries rather
          // than getting silently dropped.
          throw new Error("Discord client not ready — will retry");
        }
        try {
          const user = await client.users.fetch(discordId);
          await user.send({ content });
          await recordDmDelivery({ discordId, batchId, batchKind, status: "sent" });
        } catch (err) {
          // Permanently undeliverable (DMs off / blocked / no mutual guilds /
          // unknown user) - skip silently, don't retry (a retry can't succeed).
          // Record it as failed so the web DM console shows who couldn't be reached.
          if (isUndeliverableDm(err)) {
            const code = (err as { code?: number })?.code;
            console.warn(`[notify.dm] ${discordId} undeliverable - skipping:`, (err as Error)?.message);
            await recordDmDelivery({
              discordId,
              batchId,
              batchKind,
              status: "failed",
              errorCode: typeof code === "number" ? code : null,
              errorMsg: (err as Error)?.message ?? null,
            });
            return;
          }
          console.warn(`[notify.dm] send to ${discordId} failed - will retry:`, err);
          throw err;
        }
      }
    },
  );

  // Worker: announce pairing results to the configured Discord
  // channel/webhook. We DON'T self-throttle anymore — pull a big batch and
  // fire them concurrently, letting discord.js's REST client be the rate
  // limiter (it tracks per-route + global buckets and auto-backs-off on
  // 429s). The real ceiling is Discord's per-channel limit (~1/sec sustained
  // to one channel; higher via webhook or across channels), so a same-channel
  // burst still drains at Discord's pace — but we no longer cap it below that.
  // Per-job catch so one bad announce doesn't fail/retry the whole batch.
  await boss.work<AnnounceResultJob>(
    "notify.announce-result",
    { batchSize: 50, pollingIntervalSeconds: 5 },
    async (jobs: Job<AnnounceResultJob>[]) => {
      // PREFLIGHT: no results destination configured → don't drop or fire a
      // flood of 404s (invalid-request ban risk). Alert devops (throttled),
      // then THROW so pg-boss holds the whole batch via its exponential
      // backoff (no manual re-queue churn). Misconfig is global, so the whole
      // batch fails uniformly — none succeed, so no duplicates on retry. The
      // generous retryLimit on enqueue means they survive a long outage and
      // post once ops sets the channel.
      if (!(await announceDestinationConfigured())) {
        const now = Date.now();
        if (now - lastAnnounceConfigAlert > ANNOUNCE_CONFIG_ALERT_COOLDOWN_MS) {
          lastAnnounceConfigAlert = now;
          await postDevopsAlert(
            `⚠️ **Result announces have no destination configured** (no results webhook/channel). ` +
              `Holding announces — they'll post once a results channel or webhook is set. ` +
              `Set \`results_channel_id\`/\`results_webhook_url\` (LeagueConfig) or the env vars.`,
            true,
          ).catch(() => {});
        }
        throw new Error("results destination not configured — holding announces for retry");
      }
      await Promise.all(
        jobs.map((job) =>
          announceResult(job.data.pairingId).catch((err) =>
            console.warn(`[announce] ${job.data.pairingId} failed:`, err),
          ),
        ),
      );
    },
  );

  // Worker: rebuild the pinned #league-info message. Coalesces multi-
  // ple triggers (signups close + scheduled-start fire at once) — the
  // worker just composes from current DB state and edits the pin, so
  // running it 3x in succession produces the same content.
  await boss.work(
    "league-info.refresh",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async () => {
      await refreshLeagueInfoPinned();
    },
  );

  // Worker: silently refresh division welcome messages (roster/format updated).
  // Enqueued from the web when a schedule is regenerated, so the message stays
  // current without an admin running /league refresh-welcome. Never pings.
  await boss.work<WelcomeRefreshJob>(
    "welcome.refresh",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<WelcomeRefreshJob>[]) => {
      for (const job of jobs) {
        const r = await refreshDivisionWelcomes(job.data.seasonId, { ping: false });
        console.log(`[welcome.refresh] ${job.data.seasonId} → edited ${r.edited}, reposted ${r.reposted}, failed ${r.failed}`);
      }
    },
  );

  // Worker + schedule: re-render the read-only #league-standings post for the
  // active season. Periodic (every 15 min) so it stays current without an
  // edit per result; enqueueStandingsRefresh() also triggers it on demand
  // (e.g. right after /league setup or a season start).
  await boss.work(
    "standings.refresh",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async () => {
      await refreshStandingsMessages();
    },
  );
  await boss.schedule("standings.refresh", "*/15 * * * *");
  console.log("[pg-boss] scheduled standings.refresh every 15 min");

  // Worker + schedule: purge moderation transcripts past the retention window.
  // Short-lived by design — they exist to settle disputes/conduct reports while
  // fresh, not to archive chat. Attachments cascade-delete with their message.
  // Daily at 04:00 UTC. Idempotent schedule (upsert) keeps the cron in sync.
  await boss.work("modlog.purge", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    const cutoff = new Date(Date.now() - MODLOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await prisma.threadMessage.deleteMany({ where: { capturedAt: { lt: cutoff } } });
    if (count > 0) console.log(`[modlog.purge] deleted ${count} transcript message(s) older than ${MODLOG_RETENTION_DAYS}d`);
  });
  await boss.schedule("modlog.purge", "0 4 * * *");
  console.log("[pg-boss] scheduled modlog.purge @ 04:00 UTC daily");

  // Worker: DM a player about a roster change in their division (someone was
  // replaced) with their up-to-date schedule. One job per recipient (batchSize 1)
  // so a transient failure retries just that DM, never double-DMs the others.
  await boss.work<ScheduleChangeJob>(
    "notify.schedule-change",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<ScheduleChangeJob>[]) => {
      for (const job of jobs) {
        const client = tryGetDiscordClient();
        if (!client) throw new Error("Discord client not ready — will retry");
        const { playerId, role, divisionName, departedName, newName } = job.data;
        const player = await prisma.player.findUnique({ where: { id: playerId }, select: { discordId: true } });
        if (!player) return;
        const embed = await buildScheduleEmbed(playerId);
        const content =
          role === "new"
            ? `👋 You've been added to **${divisionName}**, taking **${sanitizeName(departedName)}**'s spot. Here's your schedule — reach out to your opponents to set up games:`
            : `🔄 **Schedule update — ${divisionName}.** **${sanitizeName(departedName)}** was dropped and replaced by **${sanitizeName(newName)}**, so one of your matchups is now against ${sanitizeName(newName)}. Your current schedule:`;
        try {
          const user = await client.users.fetch(player.discordId);
          await user.send(embed ? { content, embeds: [embed] } : { content });
        } catch (err) {
          if (isUndeliverableDm(err)) {
            console.warn(`[notify.schedule-change] ${player.discordId} undeliverable — skipping:`, (err as Error)?.message);
            return;
          }
          console.warn(`[notify.schedule-change] send to ${player.discordId} failed — will retry:`, err);
          throw err;
        }
      }
    },
  );

  // Worker: run an activity scan (walk league channels, record who's posted).
  // batchSize 1 — it's a long, rate-limited job; no retry (a re-run is a fresh
  // scan the admin triggers).
  await boss.work<{ scanId: string }>(
    "activity.scan",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<{ scanId: string }>[]) => {
      for (const job of jobs) await runActivityScan(job.data.scanId);
    },
  );

  // Worker: send the "still playing?" check-in DMs to a set of flagged players.
  await boss.work<{ playerIds: string[]; seasonId: string }>(
    "roster.checkin",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<{ playerIds: string[]; seasonId: string }>[]) => {
      for (const job of jobs) {
        const n = await runRosterCheckin(job.data);
        if (n > 0) console.log(`[roster-checkin] sent ${n} check-in DM(s)`);
      }
    },
  );

  // Worker: bootstrap one division's Discord presence. Bounded parallelism
  // (batchSize 2) so a 19-division season doesn't slam Discord all at once
  // but still finishes in seconds, not minutes.
  await boss.work<BootstrapDivisionJob>(
    "bootstrap.division",
    { batchSize: 2, pollingIntervalSeconds: 15 },
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
    { batchSize: 1, pollingIntervalSeconds: 60 },
    async (jobs: Job<MmrSnapshotJob>[]) => {
      for (const job of jobs) {
        // Per-job logging so a backlog reads as "slow but draining" rather than
        // "stuck" in the logs — each job is now ≤2 balatromp fetches.
        const t0 = Date.now();
        try {
          await snapshotPlayerMmr(job.data);
          console.log(`[snapshot.mmr] ${job.data.discordId} ✓ (${Date.now() - t0}ms)`);
        } catch (err) {
          console.warn(`[snapshot.mmr] ${job.data.discordId} ✗ after ${Date.now() - t0}ms:`, err);
          throw err; // surface to pg-boss so its retryLimit applies
        }
      }
    },
  );

  // Worker: periodic re-snapshot of CURRENT participants only — open
  // signup round signups, or (when no signups are open) active season
  // members. Past seasons are static; their snapshots are frozen on
  // purpose for historical reference, so we never re-fetch them.
  await boss.work(
    "refresh.active-mmrs",
    { batchSize: 1, pollingIntervalSeconds: 60 },
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

  // Worker: refresh every player's display name from their CURRENT server
  // (guild) display name — so the league shows their nickname, and tracks
  // changes. Daily is plenty (no live nickname hook). Players who set a
  // custom name (hasCustomDisplayName) are left alone.
  await boss.work("refresh.display-names", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await runDisplayNameRefresh();
  });
  await boss.schedule("refresh.display-names", "0 7 * * *");
  console.log("[pg-boss] scheduled refresh.display-names @ 07:00 UTC daily");

  // Worker + schedule: sync the full guild member roster (GuildMember table) for
  // username->id resolution by tools sharing this server (Team Tour). Inert unless
  // GUILD_MEMBER_SYNC=1 (the sync itself no-ops otherwise).
  await boss.work("sync.guild-members", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await runGuildMemberSync();
  });
  await boss.schedule("sync.guild-members", "30 7 * * *");
  // Also run once shortly after boot so a fresh deploy populates without waiting for
  // the daily slot (the worker picks it up after the client is ready; no-ops if the
  // GuildMembers intent isn't granted yet). singletonKey dedupes so repeated restarts
  // can't pile up overlapping runs.
  await boss.send("sync.guild-members", {}, { singletonKey: "sync.guild-members.boot" });
  console.log("[pg-boss] scheduled sync.guild-members @ 07:30 UTC daily (+ once on boot)");

  // Worker: post the public PENDING report embed to #results. Used by
  // the web-side /me report flow which can't post directly. Discord
  // /report posts inline so it normally bypasses this queue.
  await boss.work<{ pairingId: string }>(
    "report.post-pending",
    { batchSize: 5, pollingIntervalSeconds: 5 },
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
    { batchSize: 5, pollingIntervalSeconds: 60 },
    async (jobs) => {
      for (const job of jobs) {
        await autoConfirmReport(job.data.pairingId).catch((err) =>
          console.warn(`[report.auto-confirm] ${job.data.pairingId} failed:`, err),
        );
      }
    },
  );

  // Leaked-thread cleanup used to live here as an hourly pg-boss cron.
  // It's been folded into match-sweep's 60s interval (sweepLeakedThreads),
  // which already handles thread deletion for expired/idle sessions —
  // single code path, faster recovery, one less queue to maintain.

  // Worker: strip ONE division role from ONE player. Fanned out by the
  // end-of-season cleanup admin action so a 100-player season doesn't
  // ddos Discord with serial role-remove calls. Idempotent — Discord
  // returns 404 if the player no longer has the role, which the helper
  // swallows.
  await boss.work<StripRoleJob>(
    "cleanup.strip-role",
    { batchSize: 3, pollingIntervalSeconds: 15 },
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
    { batchSize: 2, pollingIntervalSeconds: 15 },
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
  await boss.work("devops.queue-stall-check", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
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
    { batchSize: 3, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) {
        await spawnDisputeThread(job.data.pairingId).catch((err) =>
          console.warn(`[dispute.spawn-thread] ${job.data.pairingId}:`, err),
        );
      }
    },
  );

  // Worker: when signups open, fan out the interactive "are you in?" ask to
  // every past player (minus opt-outs) + the 🔔 opt-in list. Computes the
  // audience + creates the PENDING ask rows, then enqueues one send per person.
  await boss.work<{ roundId: string }>(
    "signup.ask-kickoff",
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<{ roundId: string }>[]) => {
      for (const job of jobs) {
        const ids = await planSignupAskKickoff(job.data.roundId);
        for (const discordId of ids) {
          await enqueueSignupAsk({ roundId: job.data.roundId, discordId });
        }
        console.log(`[signup.ask-kickoff] ${job.data.roundId} → queued ${ids.length} asks`);
      }
    },
  );

  // Worker: send (or re-send) one person's ask DM. batchSize 1 + a poll gap so a
  // big audience drips out instead of slamming Discord; each send deletes the
  // prior DM and posts fresh so a reminder actually re-notifies. Transient
  // failures throw → pg-boss retries; permanently-undeliverable DMs are skipped
  // inside sendOrRefreshAsk.
  await boss.work<{ roundId: string; discordId: string }>(
    "signup.ask",
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<{ roundId: string; discordId: string }>[]) => {
      for (const job of jobs) {
        await sendOrRefreshAsk(job.data.roundId, job.data.discordId);
      }
    },
  );

  // Worker + schedule: hourly reminder tick. Finds who's due for a mid-window
  // nudge or a last call on the open round and enqueues their re-send. The
  // cadence math lives in planReminderTick(); this just fans out the result.
  await boss.work("signup.reminder-tick", { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    const due = await planReminderTick();
    for (const d of due) {
      await enqueueSignupAsk(d);
    }
    if (due.length) console.log(`[signup.reminder-tick] queued ${due.length} reminders`);
  });
  await boss.schedule("signup.reminder-tick", "0 * * * *");
  console.log("[pg-boss] scheduled signup.reminder-tick hourly");
}

// When signups open: kick off the interactive ask blast (audience compute +
// per-person DMs). Called from the web open-signups action via web/lib/queue.ts.
export async function enqueueSignupAskKickoff(roundId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("signup.ask-kickoff", { roundId }, { retryLimit: 3, retryBackoff: true });
}

// Send/re-send one person's ask DM. Used by the kickoff fan-out and the
// reminder tick.
export async function enqueueSignupAsk(job: { roundId: string; discordId: string }): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("signup.ask", job, { retryLimit: 3, retryBackoff: true });
}

export async function enqueueDisputeSpawnThread(pairingId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("dispute.spawn-thread", { pairingId }, { retryLimit: 2 });
}

// Mirror of web/lib/queue.ts's enqueueBootstrapDivision. The web admin
// uses it when admin clicks "Set up divisions"; the bot uses it when
// the scheduled-start sweep auto-activates a season. Same job shape,
// same worker (bootstrap.division below).
export async function enqueueBootstrapDivision(job: {
  divisionId: string;
  guildId: string;
}): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("bootstrap.division", job, { retryLimit: 2 });
}

// Trigger the bot to rebuild the pinned #league-info message. Triggered
// by web actions (signup open/close, season activate/end) and by the
// bot's own scheduled-start sweep. Coalesces if multiple fire at once —
// retries are idempotent (we just rebuild + edit again).
export async function enqueueActivityScan(scanId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("activity.scan", { scanId }, { retryLimit: 0 });
}

export async function enqueueRosterCheckin(job: { playerIds: string[]; seasonId: string }): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("roster.checkin", job, { retryLimit: 0 });
}

export async function enqueueLeagueInfoRefresh(): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("league-info.refresh", {}, { retryLimit: 2 });
}

// Trigger an immediate re-render of the #league-standings post (on top of the
// 15-min schedule) — e.g. right after /league setup or a season start.
export async function enqueueStandingsRefresh(): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("standings.refresh", {}, { retryLimit: 2 });
}

export async function enqueueDm(job: DmJob): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("notify.dm", job, { retryLimit: 3, retryBackoff: true });
}

export async function enqueueAnnounceResult(pairingId: string): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  // Generous retry with exponential backoff: covers both transient failures
  // (network blips, Discord 5xx) AND a misconfigured-destination outage (the
  // worker throws on no-destination → these back off and retry rather than
  // drop). Exponential backoff means a long outage costs very few re-pulls,
  // not constant churn; devops gets pinged so it's fixed fast either way.
  await boss.send("notify.announce-result", { pairingId }, { retryLimit: 30, retryBackoff: true });
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

interface AnnounceResultJob {
  pairingId: string;
}

interface DmJob {
  discordId: string;
  content: string;
  // Optional grouping so the notify.dm worker can record delivery (DmDelivery)
  // tagged to a mass-send (e.g. season-start:<seasonId>) or a web reply.
  batchId?: string;
  batchKind?: string;
}

// Best-effort record of one outbound DM attempt so the web DM console can show
// delivery (who got it, who couldn't be reached). Never throws into the worker.
async function recordDmDelivery(row: {
  discordId: string;
  batchId?: string;
  batchKind?: string;
  status: "sent" | "failed";
  errorCode?: number | null;
  errorMsg?: string | null;
}): Promise<void> {
  try {
    await prisma.dmDelivery.create({
      data: {
        discordId: row.discordId,
        batchId: row.batchId ?? null,
        batchKind: row.batchKind ?? null,
        status: row.status,
        errorCode: row.errorCode ?? null,
        errorMsg: row.errorMsg ?? null,
      },
    });
  } catch (err) {
    console.warn("[notify.dm] failed to record delivery:", err);
  }
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

interface WelcomeRefreshJob {
  seasonId: string;
}

// The division channel's welcome/onboarding message. Shared by the bootstrap
// (initial post) and /league refresh-welcome (edit in place). Format-aware: a
// pre-created schedule that ISN'T a full round-robin means each player has an
// ASSIGNED subset of opponents (the graph); a full round-robin (top divisions) or
// no locked schedule (legacy) = play everyone.
export async function renderDivisionWelcome(
  div: { id: string; name: string; roundRobin?: boolean | null; members: { player: { discordId: string } }[] },
  seasonLabel: string,
  roleId: string | null,
): Promise<string> {
  // One @role for the division (pings everyone in it) instead of a blob of
  // individual @mentions — the names are already in the list below. Falls back to
  // individual mentions only if the role somehow isn't set.
  const groupTag = roleId ? `<@&${roleId}>` : div.members.map((m) => `<@${m.player.discordId}>`).join(" ");
  const memberList = div.members.map((m, i) => `${i + 1}. <@${m.player.discordId}>`).join("\n");
  const N = div.members.length;
  const rrTotal = (N * (N - 1)) / 2;
  const lockedCount = await prisma.match.count({ where: { divisionId: div.id, format: "LEAGUE_BO2" } });
  // Format: the division's EXPLICIT setting if it has one (same source as the
  // standings + the schedule generator, so they always agree) — else inferred
  // from the match count. roundRobin === false means the 4-opponent graph.
  const assignedSubset =
    div.roundRobin != null ? div.roundRobin === false : lockedCount > 0 && lockedCount < rrTotal;
  const playBullet = assignedSubset
    ? `• Play **4 other people** (2 games each) — run \`/schedule\` to see exactly who you play.`
    : `• Play **every other person** in this list once — 2 games each (**${N - 1} matchups**, ${rrTotal} total in this division).`;
  const queueChannelId = await getConfig(LeagueConfigKey.LeagueQueueChannelId);
  const queueRef = queueChannelId ? `<#${queueChannelId}>` : "#league-queue";
  return [
    `# 🃏 Welcome to ${div.name}`,
    `_${seasonLabel} · ${div.name} division_`,
    ``,
    groupTag,
    ``,
    `**Your division (${div.members.length} players):**`,
    memberList,
    ``,
    `**How it works**`,
    playBullet,
    `• Run \`/start-match @opponent\` and you'll both be guided through everything — banning, picking the deck/stake, and recording each game. No manual reporting.`,
    `• Each matchup is **2 games**, each with a **fresh pool** — the combos from game 1 won't show up again in game 2. The **winner records their leftover lives** at the end of each game (used for possible future tiebreakers).`,
    `• **Scheduling your matches is your responsibility.** Reach out to each opponent — here in the channel or by DM — and get your games played. The league won't chase anyone down for you.`,
    `• Around right now? You can *also* hit **Queue up** in ${queueRef} — if a scheduled opponent is online too, I'll open the match automatically. It's a convenience for when you're free, **not a substitute for scheduling**.`,
    ``,
    `**Standings + your schedule:** <${webUrl(`divisions/${div.id}`)}>`,
    ``,
    `Good luck. 🎴`,
  ].join("\n");
}

// Refresh every active-season division's welcome message. Default: edit in place
// (silent — the roster/format in the message updates without re-pinging). With
// ping: re-post a fresh welcome that pings the @division. Shared by /league
// refresh-welcome AND the welcome.refresh job (enqueued from the web when a
// schedule is regenerated), so the message never goes stale.
export async function refreshDivisionWelcomes(
  seasonId: string,
  opts: { ping?: boolean } = {},
): Promise<{ edited: number; reposted: number; failed: number }> {
  const ping = opts.ping ?? false;
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { number: true, subtitle: true } });
  if (!season) return { edited: 0, reposted: 0, failed: 0 };
  const label = formatSeasonLabel(season);
  const divisions = await prisma.division.findMany({
    where: { seasonId, discordChannelId: { not: null } },
    select: {
      id: true,
      name: true,
      roundRobin: true,
      discordChannelId: true,
      discordRoleId: true,
      welcomeMessageId: true,
      members: { where: { status: "ACTIVE" }, select: { player: { select: { discordId: true } } } },
    },
  });
  let edited = 0;
  let reposted = 0;
  let failed = 0;
  for (const div of divisions) {
    if (!div.discordChannelId || div.members.length === 0) continue;
    const content = await renderDivisionWelcome(div, label, div.discordRoleId);
    const existingId = div.welcomeMessageId ?? (await findWelcomeMessageId(div.discordChannelId));
    if (ping) {
      if (existingId) await deleteChannelMessage(div.discordChannelId, existingId);
      const newId = await postChannelMessage(div.discordChannelId, content, true, [divisionControlsRow()]);
      if (newId) {
        await prisma.division.update({ where: { id: div.id }, data: { welcomeMessageId: newId } });
        await pinChannelMessage(div.discordChannelId, newId);
        reposted++;
      } else {
        failed++;
      }
      continue;
    }
    let msgId = existingId;
    const ok = msgId ? await editChannelMessage(div.discordChannelId, msgId, content, [divisionControlsRow()]) : false;
    if (ok) {
      edited++;
    } else {
      msgId = await postChannelMessage(div.discordChannelId, content, false, [divisionControlsRow()]);
      if (msgId) reposted++;
      else { failed++; continue; }
    }
    if (msgId !== div.welcomeMessageId) {
      await prisma.division.update({ where: { id: div.id }, data: { welcomeMessageId: msgId } });
    }
    // Keep the welcome pinned (idempotent — covers older channels that never were).
    if (msgId) await pinChannelMessage(div.discordChannelId, msgId);
  }
  return { edited, reposted, failed };
}

// Read-only dry run for refreshDivisionWelcomes: per division, would it edit the
// existing welcome in place or post a fresh one — and it always (re-)pins. No
// writes. `findWelcomeMessageId` only reads channel history.
export async function previewDivisionWelcomes(
  seasonId: string,
): Promise<Array<{ name: string; action: string }>> {
  const divisions = await prisma.division.findMany({
    where: { seasonId, discordChannelId: { not: null } },
    select: {
      id: true,
      name: true,
      discordChannelId: true,
      welcomeMessageId: true,
      members: { where: { status: "ACTIVE" }, select: { playerId: true } },
    },
  });
  const plan: Array<{ name: string; action: string }> = [];
  for (const div of divisions) {
    if (!div.discordChannelId || div.members.length === 0) continue;
    const existingId = div.welcomeMessageId ?? (await findWelcomeMessageId(div.discordChannelId));
    plan.push({
      name: div.name,
      action: existingId ? "edit existing welcome in place + ensure pinned" : "post a new welcome + pin",
    });
  }
  return plan;
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
  if (div.members.length === 0) return;

  // Done once role + channel exist — a re-run picks up wherever a partial
  // failure left off via the IDs persisted back on the Division row.
  if (div.discordRoleId && div.discordChannelId) return; // already done

  const parentId = div.season.discordCategoryId ?? undefined;
  // OWNER tier is included so a non-Administrator owner role still gets
  // explicit channel access. Discord Administrator perm holders see
  // everything anyway, but binding OWNER without Administrator is a
  // valid pattern and shouldn't lock them out.
  const staffBindings = await prisma.roleBinding.findMany({
    where: { tier: { in: ["OWNER", "ADMIN", "HELPER"] } },
  });
  const staffRoleIds = staffBindings.map((b) => b.discordRoleId);

  const seasonLabel = formatSeasonLabel(div.season);
  // 1) Role — persist immediately so a crash before channel-create doesn't
  // strand the role on a re-run.
  let roleId = div.discordRoleId;
  if (!roleId) {
    const role = await createGuildRole(guildId, `${seasonLabel}: ${div.name}`, { mentionable: false });
    if (!role) throw new Error(`createGuildRole failed for division ${div.id}`);
    roleId = role.id;
    await prisma.division.update({ where: { id: div.id }, data: { discordRoleId: roleId } });
  }

  // 2) Assign roles to all members — their division role AND the per-season
  // "League Player" role (set on the Season at season-level bootstrap). Both
  // idempotent on Discord's side so re-runs are safe.
  const leaguePlayerRoleId = div.season.leaguePlayerRoleId;
  for (const m of div.members) {
    await addGuildMemberRole(guildId, m.player.discordId, roleId);
    if (leaguePlayerRoleId) {
      await addGuildMemberRole(guildId, m.player.discordId, leaguePlayerRoleId);
    }
  }

  // 3) Channel — falls back to top level if category is full (50-channel cap)
  let channelId = div.discordChannelId;
  let welcomeMessageId = div.welcomeMessageId;
  if (!channelId) {
    // Drop the "(1)" display suffix, then sanitize for Discord (lowercase,
    // alphanumerics only — NO dashes/separators) so "Rare 1" → "rare1".
    const channelName = div.name
      .replace(/\s*\(\d+\)/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    // Members get plain access; staff roles get ManageThreads (STAFF_ALLOW) so
    // they can oversee any threads in the channel without being added to each.
    let channel = await createGuildTextChannel(guildId, channelName, {
      parentId,
      topic: `${seasonLabel} — ${div.name}`,
      visibleToRoleIds: [roleId],
      staffRoleIds,
    });
    if (!channel && parentId) {
      console.warn(`[bootstrap.division] ${channelName} couldn't fit under category — falling back to top level`);
      channel = await createGuildTextChannel(guildId, channelName, {
        topic: `${seasonLabel} — ${div.name} (overflow)`,
        visibleToRoleIds: [roleId],
        staffRoleIds,
      });
    }
    if (!channel) throw new Error(`createGuildTextChannel failed for division ${div.id}`);
    channelId = channel.id;

    // 4) Welcome message — full onboarding for everyone in this division. Posted
    // WITH a ping (pingUsers) so members get pulled into their channel at kickoff;
    // roles are already assigned (step 2) so everyone can see it. Remember the
    // message id so /league refresh-welcome can edit it later (ping-free).
    const welcome = await renderDivisionWelcome(div, seasonLabel, roleId);
    welcomeMessageId = await postChannelMessage(channelId, welcome, true, [divisionControlsRow()]);
  }

  await prisma.division.update({
    where: { id: div.id },
    data: { discordRoleId: roleId, discordChannelId: channelId, welcomeMessageId: welcomeMessageId ?? undefined },
  });

  // Pin the welcome so it stays at the top of the division channel (idempotent).
  if (channelId && welcomeMessageId) await pinChannelMessage(channelId, welcomeMessageId);

  // If this was the last division to finish, fire the season-start announcement —
  // every player now has their League Player role, so the @-ping reaches all.
  await announceSeasonStartIfComplete(div.seasonId).catch((err) =>
    console.warn(`[season.announce] check failed for ${div.seasonId}:`, err),
  );
}

// Post the "Season N is live" announcement (pinging the League Player role) —
// but only once every division with members has its channel + role, i.e. all
// role assignments are done. Claimed atomically via Season.startAnnouncedAt so
// the last of the 2-at-a-time division jobs posts exactly once.
async function announceSeasonStartIfComplete(seasonId: string): Promise<void> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      number: true,
      subtitle: true,
      leaguePlayerRoleId: true,
      startAnnouncedAt: true,
      divisions: {
        select: {
          discordChannelId: true,
          discordRoleId: true,
          _count: { select: { members: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  if (!season || season.startAnnouncedAt) return;
  const allDone = season.divisions.every(
    (d) => d._count.members === 0 || (!!d.discordChannelId && !!d.discordRoleId),
  );
  if (!allDone) return;

  // Atomic claim — only the job whose update actually flips null→now() posts.
  const claim = await prisma.season.updateMany({
    where: { id: seasonId, startAnnouncedAt: null },
    data: { startAnnouncedAt: new Date() },
  });
  if (claim.count === 0) return;

  // Per-player onboarding DMs (welcome + their matchups) instead of pinging
  // everyone to "go play". Each DM trickles out rate-limited; DMs-off players are
  // skipped silently (they'll see it via /standings).
  await queueSeasonOnboardingDms(seasonId).catch((err) =>
    console.warn(`[season.announce] onboarding DMs failed for ${seasonId}:`, err),
  );

  const channelId = await getConfig(LeagueConfigKey.AnnouncementsChannelId);
  if (!channelId) return;
  const client = tryGetDiscordClient();
  if (!client) return;
  // Ping-free: no more @everyone-go-play. The matchups went out as DMs.
  const content = `🃏 **${formatSeasonLabel(season)}** is live! Check your **DMs** for your matchups, or run \`/schedule\` anytime. Good luck.`;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      await channel.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.warn(`[season.announce] post failed for ${seasonId}:`, err);
  }
}

// Queue a welcome DM to every active member with their division + assigned
// opponents (read from the pre-created schedule matches). One enqueueDm per
// player; the worker rate-limits and silently skips anyone with DMs off.
async function queueSeasonOnboardingDms(seasonId: string): Promise<void> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      number: true,
      subtitle: true,
      divisions: {
        select: {
          name: true,
          discordChannelId: true,
          members: { where: { status: "ACTIVE" }, select: { player: { select: { id: true, discordId: true, displayName: true } } } },
          matches: { where: { format: "LEAGUE_BO2" }, select: { playerAId: true, playerBId: true } },
        },
      },
    },
  });
  if (!season) return;
  const label = formatSeasonLabel(season);

  for (const div of season.divisions) {
    const nameById = new Map(div.members.map((m) => [m.player.id, m.player.displayName]));
    const oppsById = new Map<string, string[]>();
    const add = (pid: string, name: string) => {
      const arr = oppsById.get(pid) ?? [];
      arr.push(name);
      oppsById.set(pid, arr);
    };
    for (const mt of div.matches) {
      const aN = nameById.get(mt.playerAId);
      const bN = nameById.get(mt.playerBId);
      if (aN && bN) {
        add(mt.playerAId, bN);
        add(mt.playerBId, aN);
      }
    }
    for (const m of div.members) {
      const opps = oppsById.get(m.player.id) ?? [];
      const oppLine = opps.length
        ? opps.map((o) => `• ${sanitizeName(o)}`).join("\n")
        : "_(your matchups will show with_ `/schedule`_)_";
      const content =
        `🎴 **Welcome to ${label}!**\n` +
        `You're in **${div.name}**.${div.discordChannelId ? ` Head to your division channel: <#${div.discordChannelId}>.` : ""}\n\n` +
        `**Your matchups this season:**\n${oppLine}\n\n` +
        `Play each **2 games** — just run \`/start-match @opponent\` and it guides you through it. ` +
        `Track your progress with \`/standings\`, and run \`/help\` anytime for how it all works. Good luck!`;
      await enqueueDm({
        discordId: m.player.discordId,
        content,
        batchId: `season-start:${seasonId}`,
        batchKind: "season-start",
      }).catch((err) =>
        console.warn(`[season.onboard] enqueue DM failed for ${m.player.discordId}:`, err),
      );
    }
  }
}
