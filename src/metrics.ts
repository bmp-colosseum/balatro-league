// Prometheus instrumentation for the bot. One shared Registry, exposed at
// GET /metrics on the healthcheck server (healthcheck.ts). Every metric here
// is a synchronous in-memory observe/inc -- nothing in this module may await
// on the interaction/query/job hot paths.

import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// -- Interaction handling ------------------------------------------------

// Time from dispatch start to the FIRST ack (reply/deferReply/deferUpdate/
// update/showModal/respond). Discord kills unacked interactions at 3s, so
// the buckets are dense around that boundary.
export const interactionAckSeconds = new Histogram({
  name: "bot_interaction_ack_seconds",
  help: "Time from interaction dispatch to first ack (reply/defer/update/modal)",
  labelNames: ["handler"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10],
  registers: [registry],
});

export const interactionDurationSeconds = new Histogram({
  name: "bot_interaction_duration_seconds",
  help: "Total interaction handler duration",
  labelNames: ["handler"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21],
  registers: [registry],
});

export const interactionErrorsTotal = new Counter({
  name: "bot_interaction_errors_total",
  help: "Interaction handler failures by Discord error code (10062 unknown interaction, 40060 already acked)",
  labelNames: ["handler", "code"] as const,
  registers: [registry],
});

// -- Prisma --------------------------------------------------------------

export const dbQueryDurationSeconds = new Histogram({
  name: "bot_db_query_duration_seconds",
  help: "Prisma query duration by model and operation",
  labelNames: ["model", "operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const dbQueriesTotal = new Counter({
  name: "bot_db_queries_total",
  help: "Prisma queries by model and operation",
  labelNames: ["model", "operation"] as const,
  registers: [registry],
});

// -- Discord REST --------------------------------------------------------

export const discordRestDurationSeconds = new Histogram({
  name: "bot_discord_rest_duration_seconds",
  help: "Discord REST request duration by method and normalized route",
  labelNames: ["method", "route"] as const,
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10],
  registers: [registry],
});

export const discordRestRequestsTotal = new Counter({
  name: "bot_discord_rest_requests_total",
  help: "Discord REST requests by method, normalized route, and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// -- In-process caches ---------------------------------------------------

export const cacheEventsTotal = new Counter({
  name: "bot_cache_events_total",
  help: "Hot-path cache lookups by cache and hit/miss",
  labelNames: ["cache", "result"] as const,
  registers: [registry],
});

// -- pg-boss jobs --------------------------------------------------------

export const jobDurationSeconds = new Histogram({
  name: "bot_job_duration_seconds",
  help: "pg-boss job handler duration by queue",
  labelNames: ["queue"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
  registers: [registry],
});

export const jobsTotal = new Counter({
  name: "bot_jobs_total",
  help: "pg-boss job handler completions by queue and outcome",
  labelNames: ["queue", "outcome"] as const,
  registers: [registry],
});

// -- Label normalization -------------------------------------------------

// Handler labels come from timed()'s raw labels (customIds embed cuids /
// snowflakes, e.g. "menu:match:pickselect:cmrobllr4000go22qlmt8yioc").
// Dropping ID-like segments keeps handler cardinality bounded (~40 values).
const CUID_SEGMENT = /^c[a-z0-9]{20,}$/;
const SNOWFLAKE_SEGMENT = /^\d{16,20}$/;

export function normalizeHandlerLabel(label: string): string {
  return label
    .split(":")
    .filter((seg) => !CUID_SEGMENT.test(seg) && !SNOWFLAKE_SEGMENT.test(seg))
    .join(":");
}

// REST routes carry snowflakes and (for interaction callbacks/webhooks)
// long base64ish tokens -- both are unbounded, so collapse them. Token test
// runs per-segment BEFORE digit replacement: a token containing a 16-20
// digit run would otherwise get ":id" spliced mid-segment, stop matching
// the token pattern, and leak fragments as distinct labels. Percent-encoded
// segments (reaction emoji) are unbounded too -> ":emoji".
const BASE64ISH_SEGMENT = /^[A-Za-z0-9_.-]{24,}$/;

export function normalizeRestRoute(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (BASE64ISH_SEGMENT.test(seg)) return ":token";
      if (seg.includes("%")) return ":emoji";
      return seg.replace(/\d{16,20}/g, ":id");
    })
    .join("/");
}

// Discord API error code -> the bounded label set the errors counter uses.
// 10062 = Unknown interaction (we acked too late), 40060 = already acked.
export function discordErrorCodeLabel(err: unknown): "10062" | "40060" | "other" {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === 10062 || code === "10062") return "10062";
    if (code === 40060 || code === "40060") return "40060";
  }
  return "other";
}

// -- Interaction ack instrumentation -------------------------------------

const ACK_METHODS = ["reply", "deferReply", "deferUpdate", "update", "showModal", "respond"] as const;

// Wrap the interaction's ack methods (only those present) so whichever is
// called FIRST observes bot_interaction_ack_seconds once. Pure function-call
// overhead: 'this', arguments, and return value pass through untouched.
export function instrumentAckTiming(interaction: object, handler: string, startMs: number): void {
  const target = interaction as Record<string, unknown>;
  let observed = false;
  for (const name of ACK_METHODS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    const fn = original as (this: unknown, ...args: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (!observed) {
        observed = true;
        interactionAckSeconds.observe({ handler }, (Date.now() - startMs) / 1000);
      }
      return fn.apply(this, args);
    };
  }
}

// -- pg-boss job instrumentation -----------------------------------------

// Wrap one job handler with duration + outcome accounting. Applied
// automatically to every boss.work() registration by instrumentBossWork.
export function timedJobHandler<A extends unknown[], R>(
  queue: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const start = Date.now();
    try {
      const result = await handler(...args);
      jobsTotal.inc({ queue, outcome: "completed" });
      return result;
    } catch (err) {
      jobsTotal.inc({ queue, outcome: "failed" });
      throw err;
    } finally {
      jobDurationSeconds.observe({ queue }, (Date.now() - start) / 1000);
    }
  };
}

// -- Rendering -----------------------------------------------------------

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
