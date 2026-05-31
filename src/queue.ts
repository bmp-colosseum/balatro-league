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
import { prisma } from "./db.js";
import { env } from "./env.js";
import { tryGetDiscordClient } from "./discord.js";
import {
  addGuildMemberRole,
  createGuildRole,
  createGuildTextChannel,
  postChannelMessage,
} from "./discord-helpers.js";

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
}

export async function enqueueDm(job: DmJob): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("notify.dm", job, { retryLimit: 3, retryBackoff: true });
}

interface DmJob {
  discordId: string;
  content: string;
}

interface BootstrapDivisionJob {
  divisionId: string;
  guildId: string;
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
