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
import { fetchPlayerStats } from "./balatromp.js";
import { resolveBotCommandsChannelId } from "./bot-commands-channel.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { tryGetDiscordClient } from "./discord.js";
import {
  addGuildMemberRole,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
} from "./discord-helpers.js";
import { buildLeagueExport, exportFilename, serializeExport } from "./league-export.js";
import { ChannelType, AttachmentBuilder } from "discord.js";

let boss: PgBoss | null = null;

export async function initQueue(): Promise<void> {
  if (boss) return;
  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Pg-boss installs its schema on first start. Idempotent.
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
      await refreshActiveMmrs();
    },
  );
  // Daily at 12:00 UTC. Idempotent: schedule() upserts so calling on every
  // boot just keeps the cron expression in sync. With current participants
  // (~100 max) and snapshot.mmr at 1 req/3sec, a full refresh takes ~5 min
  // — gentle on balatromp's CDN.
  await boss.schedule("refresh.active-mmrs", "0 12 * * *");
  console.log("[pg-boss] scheduled refresh.active-mmrs @ 12:00 UTC daily");

  // Weekly league backup: build JSON snapshot, post to bot-commands as
  // an attachment. Off-platform redundancy in case Railway's Postgres
  // loses data — admin scrolls back through bot-commands attachments.
  await boss.work("backup.league", { batchSize: 1 }, async () => {
    await runLeagueBackup();
  });
  // Mondays at 06:00 UTC. Idempotent like the refresh schedule.
  await boss.schedule("backup.league", "0 6 * * 1");
  console.log("[pg-boss] scheduled backup.league @ 06:00 UTC Mondays");
}

export async function enqueueDm(job: DmJob): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("notify.dm", job, { retryLimit: 3, retryBackoff: true });
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
  const channelId = await resolveBotCommandsChannelId();
  if (!channelId) {
    console.warn("[backup.league] no bot-commands channel configured; skipping post");
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
  const { stats, rawJson, error } = await fetchPlayerStats(discordId);
  // Best-effort link to a Player row if one already exists; null is fine
  // for snapshots taken at signup-close before build-season has created
  // the Player. Build-season backfills playerId later.
  const player = await prisma.player.findUnique({ where: { discordId } });
  await prisma.playerMmrSnapshot.create({
    data: {
      discordId,
      playerId: player?.id ?? null,
      seasonId,
      rankedMmr: stats?.rankedMmr ?? null,
      rankedTier: stats?.rankedTier ?? null,
      totalGames: stats?.totalGames ?? null,
      winRatePct: stats?.winRatePct ?? null,
      // Only keep the blob on failures — successful snapshots don't
      // need a JSON body per player taking up space.
      rawHtml: error ? rawJson : null,
      fetchError: error,
    },
  });
}

interface DmJob {
  discordId: string;
  content: string;
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
    where: { tier: { in: ["ADMIN", "MOD"] } },
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
    const setsToPlay = (div.members.length * (div.members.length - 1)) / 2;
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
      `• Play **every other person** in this list once — best-of-2 (${setsToPlay} sets total per player).`,
      `• Schedule in this channel. DMs work too.`,
      `• Use \`/start-match @opponent\` for the guided ban/pick flow (the bot picks the deck/stake for you), OR just play in Balatro and use \`/report @opponent result:2-0|1-1|0-2\` to log it.`,
      ``,
      `**Standings + your schedule:** <https://www.balatroleague.com/divisions/${div.id}>`,
      ``,
      `Good luck. 🎴`,
    ].join("\n");
    await postChannelMessage(channelId, welcome);
  }

  await prisma.division.update({
    where: { id: div.id },
    data: { discordRoleId: roleId, discordChannelId: channelId },
  });
}
