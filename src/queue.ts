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
import { announceResult } from "./announce.js";
import { detectCurrentBmpSeason, fetchPlayerStats, NO_RANKED_RECORD } from "./balatromp.js";
import { spawnDisputeThread } from "./dispute-thread.js";
import { webUrl } from "./web-url.js";
import { prisma } from "./db.js";
import { composeLeagueInfoContent } from "./league-info-content.js";
import { composeStandingsEmbeds } from "./standings-channel-content.js";
import { env } from "./env.js";
import { checkQueueStalls } from "./devops-alarm.js";
import { postDevopsAlert } from "./devops-alert.js";
import { tryGetDiscordClient } from "./discord.js";
import { planSignupAskKickoff, sendOrRefreshAsk, planReminderTick } from "./signup-reminders.js";

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
  isDiscordSnowflake,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  findWelcomeMessageId,
  removeGuildMemberRole as removeGuildMemberRoleViaBot,
} from "./discord-helpers.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { formatSeasonLabel } from "./format-season.js";
import { postPendingReport } from "./report-flow.js";
import { autoConfirmReport } from "./report-auto-confirm.js";
import { getLeagueSettings } from "./league-settings.js";

let boss: PgBoss | null = null;

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
  await boss.createQueue("signup.ask-kickoff");
  await boss.createQueue("signup.ask");
  await boss.createQueue("signup.reminder-tick");

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
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<DmJob>[]) => {
      for (const job of jobs) {
        const { discordId, content } = job.data;
        const client = tryGetDiscordClient();
        if (!client) {
          // Enqueued during boot before login — throw so it retries rather
          // than getting silently dropped.
          throw new Error("Discord client not ready — will retry");
        }
        try {
          const user = await client.users.fetch(discordId);
          await user.send({ content });
        } catch (err) {
          const code = (err as { code?: number })?.code;
          // Permanently undeliverable — skip silently, don't retry:
          //   50007 = DMs disabled / bot blocked / no shared server
          //   10013 = Unknown User (left the server, deleted account, or a fake
          //           seeded ID in a test run)
          if (code === 50007 || code === 10013) {
            console.warn(`[notify.dm] ${discordId} undeliverable (code ${code}) — skipping.`);
            return;
          }
          console.warn(`[notify.dm] send to ${discordId} failed (code ${code ?? "?"}) — will retry:`, err);
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
    { batchSize: 50, pollingIntervalSeconds: 1 },
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
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async () => {
      await refreshLeagueInfoPinned();
    },
  );

  // Worker: silently refresh division welcome messages (roster/format updated).
  // Enqueued from the web when a schedule is regenerated, so the message stays
  // current without an admin running /league refresh-welcome. Never pings.
  await boss.work<WelcomeRefreshJob>(
    "welcome.refresh",
    { batchSize: 1, pollingIntervalSeconds: 3 },
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
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async () => {
      await refreshStandingsMessages();
    },
  );
  await boss.schedule("standings.refresh", "*/15 * * * *");
  console.log("[pg-boss] scheduled standings.refresh every 15 min");

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

  // Worker: refresh every player's display name from their CURRENT server
  // (guild) display name — so the league shows their nickname, and tracks
  // changes. Daily is plenty (no live nickname hook). Players who set a
  // custom name (hasCustomDisplayName) are left alone.
  await boss.work("refresh.display-names", { batchSize: 1 }, async () => {
    await runDisplayNameRefresh();
  });
  await boss.schedule("refresh.display-names", "0 7 * * *");
  console.log("[pg-boss] scheduled refresh.display-names @ 07:00 UTC daily");

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

  // Worker: when signups open, fan out the interactive "are you in?" ask to
  // every past player (minus opt-outs) + the 🔔 opt-in list. Computes the
  // audience + creates the PENDING ask rows, then enqueues one send per person.
  await boss.work<{ roundId: string }>(
    "signup.ask-kickoff",
    { batchSize: 1 },
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
  await boss.work("signup.reminder-tick", { batchSize: 1 }, async () => {
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

// Build snapshot, post to the bot-commands channel as a file. Shared
// between the weekly cron and the /admin export-results command.
// Pull each player's current SERVER (guild) display name and store it as
// their league display name, so the league reflects nicknames and tracks
// changes. Individual member fetches (no privileged GuildMembers intent
// needed). Skips players who set a custom name, and silently skips anyone
// who left the guild / can't be fetched.
export async function runDisplayNameRefresh(): Promise<{ updated: number; checked: number }> {
  const guildId = env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("[refresh.display-names] no DISCORD_GUILD_ID — skipping");
    return { updated: 0, checked: 0 };
  }
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[refresh.display-names] Discord client not ready — skipping");
    return { updated: 0, checked: 0 };
  }
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn(`[refresh.display-names] couldn't fetch guild ${guildId}`);
    return { updated: 0, checked: 0 };
  }
  // Fetch ALL players: username syncs for everyone (it's the Discord handle,
  // independent of a custom display name), while displayName only syncs for
  // players who haven't set their own (hasCustomDisplayName=false).
  const players = await prisma.player.findMany({
    select: { id: true, discordId: true, displayName: true, username: true, hasCustomDisplayName: true },
  });
  let updated = 0;
  let unresolved = 0; // couldn't be fetched from Discord at all (logged)
  for (const p of players) {
    // Each player is isolated in try/catch so one transient fetch/DB error
    // can't abort the loop and strand every player after it. discord.js's REST
    // client already queues + retries 429s, so rate limits slow this down but
    // don't drop anyone — a player only ends up here on a hard, repeated error.
    try {
      if (!isDiscordSnowflake(p.discordId)) continue; // seeded/mock id — skip the API call
      const member = await guild.members.fetch(p.discordId).catch(() => null);
      const data: { displayName?: string; username?: string } = {};
      if (member) {
        // Current member: sync the league display name (global → nick → @username,
        // matching guildDisplayName()) plus the @username.
        const name = member.user.globalName ?? member.nickname ?? member.user.username;
        if (!p.hasCustomDisplayName && name && name !== p.displayName) data.displayName = name;
        if (member.user.username !== p.username) data.username = member.user.username;
      } else {
        // Left the guild — we can't read a nickname, but the @username is a global
        // identity, so fetch the User directly so ex-members still get their tag.
        const user = await client.users.fetch(p.discordId).catch(() => null);
        if (user) {
          if (user.username !== p.username) data.username = user.username;
        } else if (!p.username) {
          unresolved++;
          console.warn(`[refresh.display-names] couldn't resolve ${p.discordId} (${p.displayName}) — no member + user.fetch failed`);
        }
      }
      if (Object.keys(data).length > 0) {
        await prisma.player.update({ where: { id: p.id }, data });
        updated++;
      }
    } catch (err) {
      unresolved++;
      console.warn(`[refresh.display-names] ${p.discordId} (${p.displayName}) failed: ${(err as Error).message}`);
    }
  }
  console.log(`[refresh.display-names] updated ${updated}/${players.length} (${unresolved} unresolved)`);
  return { updated, checked: players.length };
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
  // Capture the current state — unless we resolved it for this player recently.
  // A signup-MMR re-click (or overlapping enqueues) shouldn't re-hit the
  // rate-limited balatromp API; the daily refresh runs 24h apart, well outside
  // this window, so it still updates.
  //
  // "Resolved" means a DEFINITIVE answer within the window: a captured MMR OR a
  // confirmed "no ranked record yet" (NO_RANKED_RECORD). The current season is
  // live, so "no record" is only temporary — the player could start playing —
  // so we throttle it to the same window (don't hammer the API every job for
  // someone with nothing to fetch) but NEVER mark them permanently skipped: the
  // window reopens and they get rechecked. Transient HTTP/timeout rows are not
  // "resolved", so those retry promptly.
  const FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6h
  const recentlyResolved = currentBmpSeason
    ? await prisma.playerMmrSnapshot.findFirst({
        where: {
          discordId,
          bmpSeason: currentBmpSeason,
          OR: [{ fetchError: null }, { fetchError: NO_RANKED_RECORD }],
          capturedAt: { gte: new Date(Date.now() - FRESHNESS_MS) },
        },
        select: { id: true },
      })
    : null;
  if (recentlyResolved) {
    console.log(`[snapshot.mmr] ${discordId} — current (${currentBmpSeason}) checked <6h ago, skipping`);
  } else {
    await fetchAndStore(discordId, player?.id ?? null, seasonId, currentBmpSeason);
  }

  if (!currentBmpSeason) return;
  const prev = previousBmpSeason(currentBmpSeason);
  if (!prev) return;

  // Also capture the PREVIOUS BMP season — enough for the "hasn't played the
  // current season, fall back to their last one" case (the signup MMR view +
  // the profile's last-2-seasons trend). We deliberately do NOT backfill ALL of
  // history (season1…current-1) anymore: that turned a single signup-MMR
  // refresh into ~N fetches PER player, which buried the rate-limited
  // snapshot.mmr queue and tripped the stall alert.
  //
  // A past season is FROZEN, so we only ever need ONE definitive answer per
  // player: either we captured their ranked row, OR balatromp confirmed they
  // have no record for it (NO_RANKED_RECORD) — that "no record" is permanent
  // too, so a player who didn't play last season must NOT be re-fetched every
  // job forever. We DO retry rows that exist only because the fetch failed
  // transiently (HTTP/timeout), and the force-recapture flag overrides all of
  // this to overwrite briefly-bad API data.
  const forceRecapture = (await getConfig(LeagueConfigKey.BmpCapturePreviousSeason)) === "true";
  if (!forceRecapture) {
    const haveDefinitive = await prisma.playerMmrSnapshot.findFirst({
      where: {
        discordId,
        bmpSeason: prev,
        OR: [{ fetchError: null }, { fetchError: NO_RANKED_RECORD }],
      },
      select: { id: true },
    });
    if (haveDefinitive) return;
  }
  await fetchAndStore(discordId, player?.id ?? null, seasonId, prev);
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
  const label = bmpSeason ?? "current";
  if (!error) {
    console.log(`[snapshot.mmr] ${discordId} (${label}) → mmr=${stats?.rankedMmr ?? "—"} tier=${stats?.rankedTier ?? "—"}`);
  } else if (error === NO_RANKED_RECORD) {
    // Not a failure — the player simply has no Ranked row for this query
    // (hasn't played that season). Still recorded (so the skip checks see a
    // definitive answer), but logged as info, not an error.
    console.log(`[snapshot.mmr] ${discordId} (${label}) — no ranked record yet`);
  } else {
    console.warn(`[snapshot.mmr] ${discordId} (${label}) fetch failed: ${error}`);
  }
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
      // Only keep the blob on genuine failures (to debug a parse/HTTP issue) —
      // a success or a benign "no record" doesn't need a JSON body per player
      // taking up space.
      rawHtml: error && error !== NO_RANKED_RECORD ? rawJson : null,
      fetchError: error,
    },
  });
}

// Rebuild + edit the pinned #league-info message. Idempotent — pulls
// fresh DB state via composeLeagueInfoContent every invocation, so
// multiple triggers fold into the same result. Looks for the bot's
// own pinned message first; falls back to posting + pinning a new one
// if none exists.
async function refreshLeagueInfoPinned(): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.LeagueInfoChannelId);
  if (!channelId) {
    console.warn("[league-info.refresh] no LeagueInfoChannelId set — skipping");
    return;
  }
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[league-info.refresh] Discord client not ready — skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[league-info.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const content = await composeLeagueInfoContent();
  const botId = client.user?.id;
  type MiniMsg = { id: string; author: { id: string }; edit: (o: { content: string }) => Promise<unknown>; pin: () => Promise<unknown> };
  const messages = (channel as {
    messages: {
      fetch: (id: string) => Promise<MiniMsg>;
      fetchPinned: () => Promise<{ values: () => Iterable<MiniMsg> }>;
    };
    send: (o: { content: string }) => Promise<MiniMsg>;
  });
  try {
    // 1. Edit the remembered message if it still exists — keyed on a stored
    //    id, NOT on pin state, so an unpinned message can't cause a dupe.
    const storedId = await getConfig(LeagueConfigKey.LeagueInfoMessageId);
    if (storedId) {
      const existing = await messages.messages.fetch(storedId).catch(() => null);
      if (existing && existing.author.id === botId) {
        await existing.edit({ content });
        return;
      }
    }
    // 2. No stored id (or it's gone) — adopt an existing pinned bot message
    //    if there is one (migration path), so we don't post a duplicate.
    const pinned = await messages.messages.fetchPinned().catch(() => null);
    if (pinned) {
      for (const msg of pinned.values()) {
        if (msg.author.id === botId) {
          await msg.edit({ content });
          await setConfig(LeagueConfigKey.LeagueInfoMessageId, msg.id, "league-info.refresh");
          return;
        }
      }
    }
    // 3. Nothing to edit — post + pin a new one and remember its id.
    const sent = await messages.send({ content });
    await sent.pin().catch((err: unknown) => console.warn("[league-info.refresh] pin failed:", err));
    await setConfig(LeagueConfigKey.LeagueInfoMessageId, sent.id, "league-info.refresh");
    console.log(`[league-info.refresh] posted + pinned new message in ${channelId}`);
  } catch (err) {
    console.warn(`[league-info.refresh] failed: ${(err as Error).message}`);
  }
}

// Re-render the read-only #league-standings post. Standings can span several
// messages (Discord caps embeds at 10/message), so we keep an ordered list of
// the bot's message ids: edit the i-th in place, post a new one if we grew, and
// delete any trailing leftovers if the division count shrank. Idempotent —
// recomputes from current DB state every run.
async function refreshStandingsMessages(): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.StandingsChannelId);
  if (!channelId) return; // standings feed not configured — nothing to do
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[standings.refresh] Discord client not ready — skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[standings.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const embeds = await composeStandingsEmbeds();
  // Chunk into messages of <=10 embeds (Discord's per-message limit).
  const groups: (typeof embeds)[] = [];
  for (let i = 0; i < embeds.length; i += 10) groups.push(embeds.slice(i, i + 10));

  const botId = client.user?.id;
  type MiniMsg = {
    id: string;
    author: { id: string };
    edit: (o: { embeds: typeof embeds }) => Promise<unknown>;
    delete: () => Promise<unknown>;
  };
  const ch = channel as {
    messages: { fetch: (id: string) => Promise<MiniMsg> };
    send: (o: { embeds: typeof embeds }) => Promise<MiniMsg>;
  };

  const storedRaw = await getConfig(LeagueConfigKey.StandingsMessageIds);
  let storedIds: string[] = [];
  try {
    storedIds = storedRaw ? JSON.parse(storedRaw) : [];
  } catch {
    storedIds = [];
  }

  try {
    const newIds: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const existingId = storedIds[i];
      if (existingId) {
        const existing = await ch.messages.fetch(existingId).catch(() => null);
        if (existing && existing.author.id === botId) {
          await existing.edit({ embeds: groups[i]! });
          newIds.push(existingId);
          continue;
        }
      }
      const sent = await ch.send({ embeds: groups[i]! });
      newIds.push(sent.id);
    }
    // Delete trailing messages we no longer need (division count shrank).
    for (let i = groups.length; i < storedIds.length; i++) {
      await ch.messages.fetch(storedIds[i]!).then((m) => m.delete()).catch(() => {});
    }
    await setConfig(LeagueConfigKey.StandingsMessageIds, JSON.stringify(newIds), "standings.refresh");
  } catch (err) {
    console.warn(`[standings.refresh] failed: ${(err as Error).message}`);
  }
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

interface AnnounceResultJob {
  pairingId: string;
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

interface WelcomeRefreshJob {
  seasonId: string;
}

interface MmrSnapshotJob {
  // Canonical key — works even when no Player row exists yet (new signups
  // captured at signup-close, before build-season materializes Players).
  discordId: string;
  // Null = ad-hoc capture not tied to a season (admin refresh of a player).
  seasonId: string | null;
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
    `• Schedule here in the channel, or by DM.`,
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
      const newId = await postChannelMessage(div.discordChannelId, content, true);
      if (newId) {
        await prisma.division.update({ where: { id: div.id }, data: { welcomeMessageId: newId } });
        reposted++;
      } else {
        failed++;
      }
      continue;
    }
    let msgId = existingId;
    const ok = msgId ? await editChannelMessage(div.discordChannelId, msgId, content) : false;
    if (ok) {
      edited++;
    } else {
      msgId = await postChannelMessage(div.discordChannelId, content);
      if (msgId) reposted++;
      else { failed++; continue; }
    }
    if (msgId !== div.welcomeMessageId) {
      await prisma.division.update({ where: { id: div.id }, data: { welcomeMessageId: msgId } });
    }
  }
  return { edited, reposted, failed };
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
    const role = await createGuildRole(guildId, `${seasonLabel}: ${div.name}`, { mentionable: true });
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
    welcomeMessageId = await postChannelMessage(channelId, welcome, true);
  }

  await prisma.division.update({
    where: { id: div.id },
    data: { discordRoleId: roleId, discordChannelId: channelId, welcomeMessageId: welcomeMessageId ?? undefined },
  });

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
        ? opps.map((o) => `• ${o}`).join("\n")
        : "_(your matchups will show with_ `/schedule`_)_";
      const content =
        `🎴 **Welcome to ${label}!**\n` +
        `You're in **${div.name}**.\n\n` +
        `**Your matchups this season:**\n${oppLine}\n\n` +
        `Play each **2 games** — just run \`/start-match @opponent\` and it guides you through it. ` +
        `Track your progress with \`/standings\`, and run \`/league\` anytime for how it all works. Good luck!`;
      await enqueueDm({ discordId: m.player.discordId, content }).catch((err) =>
        console.warn(`[season.onboard] enqueue DM failed for ${m.player.discordId}:`, err),
      );
    }
  }
}
