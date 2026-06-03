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

export async function enqueueBootstrapDivision(job: {
  divisionId: string;
  guildId: string;
}): Promise<void> {
  await ensureStarted();
  // Lower retry count than DMs — a bootstrap failure usually means a
  // missing permission or wrong guild id, not a transient hiccup, so
  // hammering retries just delays the admin seeing the real error.
  await getBoss().send("bootstrap.division", job, {
    retryLimit: 1,
    retryBackoff: true,
  });
}

export async function enqueueMmrSnapshot(job: {
  discordId: string;
  seasonId: string | null;
}): Promise<void> {
  await ensureStarted();
  // Two retries — balatromp.com is occasionally flaky but we still want
  // to capture even if the first attempt fails. Failure beyond that gets
  // recorded in PlayerMmrSnapshot.fetchError so admin can see it.
  await getBoss().send("snapshot.mmr", job, {
    retryLimit: 2,
    retryBackoff: true,
  });
}

// Web-side report just creates a PENDING Pairing; the bot owns the
// public #results embed + the 2-min auto-confirm timer. These two
// enqueues hand the rest of the flow off.
export async function enqueueReportPostPending(pairingId: string): Promise<void> {
  await ensureStarted();
  await getBoss().send("report.post-pending", { pairingId }, { retryLimit: 2 });
}

// Trigger the bot to rebuild the pinned #league-info message. Mirror
// of the bot-side enqueueLeagueInfoRefresh. Fire from any web action
// that changes the "current state" reflected in the pinned content
// (signup open/close, season activate/end).
export async function enqueueLeagueInfoRefresh(): Promise<void> {
  await ensureStarted();
  await getBoss().send("league-info.refresh", {}, { retryLimit: 2 });
}

// Enqueue an announce. Caller returns immediately — pg-boss worker on
// the bot side picks it up and runs announceResult() at the queue's
// natural rate (1/sec polling, batchSize 1). Far better than calling
// announceResult inline because:
//   - Caller doesn't block on Discord round-trip
//   - Bursts (e.g. rapid-fire admin edits) drain at a controlled
//     pace instead of hitting rate limits
//   - Failures retry automatically with backoff
export async function enqueueAnnounceResult(pairingId: string): Promise<void> {
  await ensureStarted();
  await getBoss().send("notify.announce-result", { pairingId }, { retryLimit: 2, retryBackoff: true });
}

export async function enqueueReportAutoConfirm(pairingId: string): Promise<void> {
  await ensureStarted();
  const { getLeagueSettings } = await import("@/lib/league-settings");
  const settings = await getLeagueSettings();
  await getBoss().send(
    "report.auto-confirm",
    { pairingId },
    { startAfter: settings.reportAutoConfirmSeconds, retryLimit: 2 },
  );
}

// Spawns the Discord helper-mediation thread for a freshly-disputed
// match. Bot owns the worker (Discord client lives there); web enqueues.
export async function enqueueDisputeSpawnThread(pairingId: string): Promise<void> {
  await ensureStarted();
  await getBoss().send("dispute.spawn-thread", { pairingId }, { retryLimit: 2 });
}

// End-of-season role cleanup — one job per (member, role) so a season
// with 100 members fans out cleanly through the existing pg-boss
// rate-limited worker rather than hammering Discord serially. Idempotent
// per-job: if the player no longer has the role, the call is a no-op.
export async function enqueueStripDivisionRole(job: {
  guildId: string;
  discordId: string;
  roleId: string;
}): Promise<void> {
  await ensureStarted();
  await getBoss().send("cleanup.strip-role", job, { retryLimit: 2, retryBackoff: true });
}

// Award the per-division champion role to one winner. Bot worker creates
// the role on demand (storing the id on Division.championRoleId for
// idempotent re-runs) + assigns to the winner.
export async function enqueueAwardChampionRole(job: {
  guildId: string;
  divisionId: string;
  winnerDiscordId: string;
  roleName: string;
}): Promise<void> {
  await ensureStarted();
  await getBoss().send("award.champion-role", job, { retryLimit: 2, retryBackoff: true });
}
