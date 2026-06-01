// Queue-stall detector. Walks pg-boss's job table for work that's been
// in the 'created' state (queued, never picked up) longer than the
// alert threshold. Posts to #devops pinging DEVOPS role bindings.
//
// This is the BMP-style failure canary: a healthy worker drains
// jobs in seconds. Any job sitting in 'created' for >5min means a
// worker is stalled, dead, or its handler is stuck in a long await.
// Catching this before users notice is the whole point of having
// the alarm.
//
// Threshold + cooldown:
//   STALL_THRESHOLD_SECONDS = 300 (5 min)
//   Posts at most once per queue per hour — pg-boss might re-fire the
//   cron before the underlying issue clears; we don't want to spam.

import { ChannelType, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { resolveDevopsChannelId } from "./devops-channel.js";
import { tryGetDiscordClient } from "./discord.js";

const STALL_THRESHOLD_SECONDS = 300;
const POST_COOLDOWN_MINUTES = 60;

// In-memory cooldown — survives within a single bot process. If the
// process restarts, the cooldown resets, which is acceptable; restart
// itself is interesting and worth re-noticing.
const lastPostedByQueue = new Map<string, number>();

interface StalledQueue {
  name: string;
  oldestAgeSeconds: number;
  jobCount: number;
}

export async function checkQueueStalls(): Promise<{
  checked: number;
  stalled: StalledQueue[];
  posted: boolean;
}> {
  // pg-boss v12 schema lives at pgboss.job. Query is intentionally raw:
  // we don't have a Prisma model for the queue table (it's external),
  // and the query is read-only + bounded. The 'created' state is what
  // pg-boss assigns to fresh jobs that haven't been picked up; once a
  // worker grabs one it flips to 'active'.
  const rows = await prisma.$queryRawUnsafe<
    Array<{ name: string; oldest_age_seconds: number; job_count: bigint }>
  >(
    `SELECT name,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_on)))::int AS oldest_age_seconds,
            COUNT(*) AS job_count
       FROM pgboss.job
      WHERE state = 'created'
        AND start_after <= NOW()
        AND created_on < NOW() - INTERVAL '${STALL_THRESHOLD_SECONDS} seconds'
      GROUP BY name
      ORDER BY oldest_age_seconds DESC`,
  );

  const stalled: StalledQueue[] = rows.map((r) => ({
    name: r.name,
    oldestAgeSeconds: Number(r.oldest_age_seconds),
    jobCount: Number(r.job_count),
  }));

  if (stalled.length === 0) {
    return { checked: 1, stalled: [], posted: false };
  }

  // Filter against per-queue cooldown so we don't spam if the issue
  // persists across multiple sweeps.
  const now = Date.now();
  const cooldownMs = POST_COOLDOWN_MINUTES * 60 * 1000;
  const newlyStalled = stalled.filter((s) => {
    const last = lastPostedByQueue.get(s.name) ?? 0;
    return now - last > cooldownMs;
  });

  if (newlyStalled.length === 0) {
    console.warn(
      `[devops-alarm] ${stalled.length} queues still stalled but in cooldown:`,
      stalled.map((s) => `${s.name}(${s.jobCount}@${s.oldestAgeSeconds}s)`).join(" "),
    );
    return { checked: 1, stalled, posted: false };
  }

  // Mark all currently-stalled queues as posted, even ones in cooldown
  // — they're still part of the situation report and we don't want to
  // post again the next time the cron fires.
  for (const s of stalled) lastPostedByQueue.set(s.name, now);

  const channelId = await resolveDevopsChannelId();
  const client = tryGetDiscordClient();
  if (!channelId || !client) {
    console.warn("[devops-alarm] no devops channel or client; logging only:", stalled);
    return { checked: 1, stalled, posted: false };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.warn(`[devops-alarm] channel ${channelId} not a text channel`);
      return { checked: 1, stalled, posted: false };
    }
    const devopsBindings = await prisma.roleBinding.findMany({ where: { tier: "DEVOPS" } });
    const mentions = devopsBindings.map((b) => `<@&${b.discordRoleId}>`).join(" ");
    const lines = stalled.map(
      (s) =>
        `• \`${s.name}\` — **${s.jobCount}** job(s), oldest **${formatAge(s.oldestAgeSeconds)}**`,
    );
    const body = [
      `${mentions ? mentions + " " : ""}🚨 **Queue stall detected**`,
      ``,
      ...lines,
      ``,
      `_Threshold: jobs stuck in 'created' state >${STALL_THRESHOLD_SECONDS}s._`,
      `_Cooldown: ${POST_COOLDOWN_MINUTES}min per queue — no repeat alert until then._`,
      ``,
      `Likely causes: handler hung on an await, worker process dead, DB lock contention. Check Railway logs.`,
    ].join("\n");
    await (channel as TextChannel).send({ content: body });
    return { checked: 1, stalled, posted: true };
  } catch (err) {
    console.warn("[devops-alarm] post failed:", err);
    return { checked: 1, stalled, posted: false };
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
