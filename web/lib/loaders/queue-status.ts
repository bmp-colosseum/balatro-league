import "server-only";

// Read-side for the pg-boss job queue (schema "pgboss", shared with the bot).
// Surfaces what's queued, what's stalled, and recent failures + their error text
// on /admin/ops — so ops can see queue health without digging through Railway
// logs or the DB. pg-boss v12: pgboss.job is a partitioned parent table (SELECT
// spans all partitions); states are created/retry/active/completed/cancelled/failed.

import { prisma } from "@/lib/prisma";

export interface QueueSummary {
  name: string;
  created: number; // pending, waiting for a worker
  retry: number; // failed once, awaiting retry
  active: number; // currently being worked
  failed: number; // exhausted retries
  completedRecently: number; // completed (still in job table, pre-archive)
  oldestPending: Date | null; // oldest created/retry job — the stall signal
}

export interface FailedJob {
  id: string;
  name: string;
  createdOn: Date | null;
  failedAt: Date | null;
  retryCount: number;
  error: string;
}

interface CountRow {
  name: string;
  state: string;
  count: number;
  oldest: Date | null;
}

// Per-queue counts by state + the oldest pending job (for stall detection).
export async function loadQueueSummaries(): Promise<QueueSummary[]> {
  let rows: CountRow[];
  try {
    rows = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT name, state::text AS state, count(*)::int AS count, min(created_on) AS oldest
         FROM pgboss.job
        GROUP BY name, state`,
    );
  } catch (err) {
    console.warn("[queue-status] loadQueueSummaries failed:", err);
    return [];
  }
  const byQueue = new Map<string, QueueSummary>();
  const get = (name: string): QueueSummary => {
    let q = byQueue.get(name);
    if (!q) {
      q = { name, created: 0, retry: 0, active: 0, failed: 0, completedRecently: 0, oldestPending: null };
      byQueue.set(name, q);
    }
    return q;
  };
  for (const r of rows) {
    const q = get(r.name);
    if (r.state === "created") q.created = r.count;
    else if (r.state === "retry") q.retry = r.count;
    else if (r.state === "active") q.active = r.count;
    else if (r.state === "failed") q.failed = r.count;
    else if (r.state === "completed") q.completedRecently = r.count;
    // Oldest pending = oldest created OR retry job.
    if ((r.state === "created" || r.state === "retry") && r.oldest) {
      if (!q.oldestPending || r.oldest < q.oldestPending) q.oldestPending = r.oldest;
    }
  }
  // Queues with anything interesting first (pending/active/failed), then the rest.
  return [...byQueue.values()].sort((a, b) => {
    const score = (q: QueueSummary) => q.failed * 1000 + q.created + q.retry + q.active;
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });
}

interface FailedRow {
  id: string;
  name: string;
  created_on: Date | null;
  completed_on: Date | null;
  retry_count: number;
  output: unknown;
}

// Pull a human-readable error string out of pg-boss's jsonb `output` (which holds
// whatever the worker threw — usually {message, stack} or a raw value).
function errorText(output: unknown): string {
  if (output == null) return "(no error detail)";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.value === "string") return o.value;
    try {
      return JSON.stringify(o);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

// Recently FAILED jobs (retries exhausted), newest first, with their error text.
// These are still in pgboss.job (older ones archive out) and so are retryable.
export async function loadFailedJobs(limit = 50): Promise<FailedJob[]> {
  let rows: FailedRow[];
  try {
    rows = await prisma.$queryRawUnsafe<FailedRow[]>(
      `SELECT id::text AS id, name, created_on, completed_on, retry_count::int AS retry_count, output
         FROM pgboss.job
        WHERE state = 'failed'
        ORDER BY completed_on DESC NULLS LAST
        LIMIT ${Math.max(1, Math.min(200, limit))}`,
    );
  } catch (err) {
    console.warn("[queue-status] loadFailedJobs failed:", err);
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdOn: r.created_on,
    failedAt: r.completed_on,
    retryCount: r.retry_count,
    error: errorText(r.output),
  }));
}
