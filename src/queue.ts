// Durable job queue for fire-and-forget Discord work. Survives crashes
// (jobs persist in Postgres), retries 429s automatically via discord.js
// inside the handler, and decouples high-volume operations from the
// triggering request.
//
// Current jobs:
//   notify.dm  — send a DM to a user. Used by the next-season blast so
//                a crash mid-blast doesn't lose subscribers.
//
// More can be added by registering another work() handler in initQueue().
// All web-side enqueues happen via web/lib/queue.ts which talks to the
// same Postgres tables; this file owns the workers.

import { PgBoss, type Job } from "pg-boss";
import { env } from "./env.js";
import { tryGetDiscordClient } from "./discord.js";

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
      // pg-boss interprets thrown errors as "retry". Resolved promises = success.
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(`[notify.dm] ${failures.length}/${jobs.length} failed:`, failures);
      }
    },
  );
}

export async function enqueueDm(job: DmJob): Promise<void> {
  if (!boss) throw new Error("Queue not initialized — initQueue() must run first");
  await boss.send("notify.dm", job, {
    retryLimit: 3,
    retryBackoff: true, // exponential
  });
}

interface DmJob {
  discordId: string;
  content: string;
}
