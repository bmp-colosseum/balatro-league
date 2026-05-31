// Web-side pg-boss client. ONLY enqueues — the bot service (src/queue.ts)
// owns the workers that actually process jobs. Both sides talk to the same
// Postgres + pgboss schema, so a job sent here is picked up there.
//
// We lazy-start a single PgBoss instance per process so the connection
// survives Next's hot-reload. If the very first send happens before pgboss
// has set up its schema, .start() handles that (idempotent).
//
// Add a new job type? Add an `enqueueX()` here AND a matching `boss.work()`
// in src/queue.ts. The job name is the contract.

import { PgBoss } from "pg-boss";

declare global {
  // eslint-disable-next-line no-var
  var __pgboss: PgBoss | undefined;
  // eslint-disable-next-line no-var
  var __pgbossStart: Promise<void> | undefined;
}

function getBoss(): PgBoss {
  if (!globalThis.__pgboss) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set — cannot enqueue jobs");
    globalThis.__pgboss = new PgBoss({ connectionString: url, schema: "pgboss" });
    globalThis.__pgboss.on("error", (err: Error) =>
      console.warn("[pg-boss web] error:", err),
    );
  }
  return globalThis.__pgboss;
}

async function ensureStarted(): Promise<void> {
  if (!globalThis.__pgbossStart) {
    globalThis.__pgbossStart = getBoss()
      .start()
      .then(() => {
        console.log("[pg-boss web] connected");
      })
      .catch((err) => {
        // Reset so the next call tries again — don't cache the failure.
        globalThis.__pgbossStart = undefined;
        throw err;
      });
  }
  return globalThis.__pgbossStart;
}

export async function enqueueDm(job: { discordId: string; content: string }): Promise<void> {
  await ensureStarted();
  await getBoss().send("notify.dm", job, {
    retryLimit: 3,
    retryBackoff: true,
  });
}
