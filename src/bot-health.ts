// Continuous health monitor for the bot. A 60s tick gathers plain
// measurements (DB latency, Discord gateway ping, a rolling window of REST
// call timings, pg-boss queue stalls, an at-most-once-per-5min poll of
// Discord's own status page), hands them to the pure deriveHealth()
// decision function, caches the resulting snapshot in memory, and reflects
// it in the bot's Discord presence. /league-bot-status (commands/bot-status.ts)
// reads ONLY the cache via getCachedHealth() -- it never re-runs checks, so
// the command is instant no matter how slow the underlying systems are.
//
// Two things beyond raw ok/degraded/down live here:
//   - ALERT_EXEMPT_QUEUES -- low-priority background queues (snapshot.mmr)
//     whose stalls are visible in the snapshot but never degrade `level`
//     or page the owner. See isAlertExemptQueue.
//   - attribution -- deriveAttribution's best guess at WHOSE fault a
//     Discord-side degradation is (Discord itself, confirmed via
//     discord-status.ts's corroboration, vs. our own network egress).
//
// Pure/shell split: deriveHealth(), deriveAttribution(), describeAttribution(),
// isAlertExemptQueue(), and computeRestStats()/percentile() are the only
// places a raw measurement becomes a verdict -- unit-tested with zero
// DB/Discord/network I/O. Everything else here (the tick, the presence
// update, the REST sample seam) is the thin imperative shell that gathers
// data and hands it to the pure core.

import { ActivityType, type Client } from "discord.js";
import { prisma } from "./db.js";
import { checkQueueStalls } from "./devops-alarm.js";
import { activePublicSeason } from "./active-season.js";
import { formatSeasonLabel } from "./format-season.js";
import { onHealthTransition } from "./health-broadcast.js";
import { refreshBotStatusMessage } from "./channel-refresh.js"; // takes the snapshot by value -- no import cycle
import { fetchDiscordStatus } from "./discord-status.js";

export type HealthLevel = "ok" | "degraded" | "down";

// PURE data shape -- discord-status.ts (the shell that actually polls
// discordstatus.com) imports this type back, never the reverse at runtime.
export interface DiscordStatusInfo {
  indicator: string;
  description: string;
}

// Who's most likely at fault for the current `level`, in plain terms. See
// deriveAttribution for the decision rules and describeAttribution for the
// admin-facing text. ADMIN-ONLY -- never surfaced on the public embed.
export type Attribution = "discord" | "network" | "database" | "queue" | "none" | "unknown";

export interface BotHealth {
  level: HealthLevel;
  checkedAt: Date;
  discord: {
    gatewayPingMs: number | null;
    restP95Ms: number | null;
    restErrorRate: number | null;
    level: HealthLevel;
  };
  db: { latencyMs: number | null; ok: boolean };
  // `stalled` is genuinely-stalled queues that are NOT alert-exempt -- these
  // are what drive `level`/notes/the devops alert. `stalledLowPriority` is
  // the alert-exempt subset (currently just snapshot.mmr): still reported
  // for discoverability, never alerted on. Optional only so a hand-built
  // BotHealth (tests, future call sites) doesn't have to spell out an empty
  // array; deriveHealth always sets it explicitly.
  queue: { stalled: string[]; stalledLowPriority?: string[]; ok: boolean };
  notes: string[];
  // External corroboration from discordstatus.com (discord-status.ts), or
  // null when it couldn't be reached / hasn't been polled yet ("unknown").
  discordStatus: DiscordStatusInfo | null;
  attribution: Attribution;
}

// -- Thresholds ------------------------------------------------------------
// Tuned against a real incident where Discord's own API was slow: a 4.3s
// p95 on message edits. REST_P95_DEGRADED_MS is set well under that so this
// monitor actually catches "Discord is having issues" instead of only
// noticing after it's gotten far worse.
export const REST_P95_DEGRADED_MS = 2000;
export const REST_ERROR_RATE_DEGRADED = 0.05; // 5%
export const GATEWAY_PING_DEGRADED_MS = 1000;
// Below this many REST samples in the rolling window, p95/error-rate are
// reported as "insufficient data" rather than a number computed from 1-2
// calls (which would be noise, not signal).
export const MIN_REST_SAMPLES_FOR_SIGNAL = 5;

// -- Alert-exempt queues ----------------------------------------------------
// Queues in here are low-priority background work: never player-impacting,
// and the owner does not want to be paged about them. Currently just
// snapshot.mmr (a background balatromp.com stats refresh -- see queue.ts).
// A stall in one of these queues stays fully visible in the BotHealth
// snapshot (BotHealth.queue.stalledLowPriority, below) so a genuinely
// broken refresh is still discoverable in the admin embed -- it just never
// flips `level` to "degraded" and never fires the devops alert. Add a queue
// name here ONLY when it's truly background/non-player-facing; everything
// else should keep alerting.
export const ALERT_EXEMPT_QUEUES: ReadonlySet<string> = new Set(["snapshot.mmr"]);

// PURE. The explicit exemption rule ALERT_EXEMPT_QUEUES documents above --
// pulled into its own function so the rule has one obvious place to read
// and test, instead of an inline `.has()` scattered through deriveHealth.
export function isAlertExemptQueue(queueName: string): boolean {
  return ALERT_EXEMPT_QUEUES.has(queueName);
}

// -- Rolling REST window (pure aggregation, impure storage) ---------------

export interface RestSample {
  durationMs: number;
  ok: boolean;
}

export interface RestStats {
  restP95Ms: number | null;
  restErrorRate: number | null;
  sampleCount: number;
}

// PURE. Nearest-rank percentile: sorts ascending, picks the
// ceil(p/100 * n)-th smallest value (1-indexed, clamped into range).
export function percentile(valuesMs: readonly number[], p: number): number {
  if (valuesMs.length === 0) return 0;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  // rank is clamped into [1, sorted.length] above and sorted is non-empty
  // (guarded at the top), so this index is always in range.
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error("percentile: index out of range (unreachable)");
  return value;
}

// PURE. Turns a batch of REST samples into the aggregate stats deriveHealth
// consumes. See MIN_REST_SAMPLES_FOR_SIGNAL for the insufficient-data floor.
export function computeRestStats(samples: readonly RestSample[]): RestStats {
  const sampleCount = samples.length;
  if (sampleCount < MIN_REST_SAMPLES_FOR_SIGNAL) {
    return { restP95Ms: null, restErrorRate: null, sampleCount };
  }
  const durations = samples.map((s) => s.durationMs);
  const errorCount = samples.filter((s) => !s.ok).length;
  return {
    restP95Ms: percentile(durations, 95),
    restErrorRate: errorCount / sampleCount,
    sampleCount,
  };
}

// -- Pure decision core ------------------------------------------------------

export interface HealthSampleInputs {
  db: { ok: boolean; latencyMs: number | null };
  discord: { gatewayPingMs: number | null } & RestStats;
  // Every GENUINELY stalled queue (already passed through
  // filterGenuinelyStalled in the shell) -- both alert-exempt and not.
  // deriveHealth is what splits them via isAlertExemptQueue.
  queue: { stalled: string[] };
  // discordstatus.com's current indicator, or null when unknown/unreachable
  // (see discord-status.ts). Only consulted when discordLevel !== "ok" --
  // see deriveAttribution.
  discordStatus: DiscordStatusInfo | null;
}

// PURE. Maps raw measurements -> a BotHealth verdict. Rules (in priority
// order):
//   1. db unreachable ("db.ok: false")            -> "down", regardless of
//      anything else -- nothing works without the database.
//   2. Discord REST p95 > REST_P95_DEGRADED_MS, OR REST error rate >
//      REST_ERROR_RATE_DEGRADED, OR gateway ping > GATEWAY_PING_DEGRADED_MS
//      -> "degraded", with a note naming Discord specifically.
//   3. any NON-exempt stalled queue (isAlertExemptQueue false)   -> "degraded".
//      An alert-exempt queue (ALERT_EXEMPT_QUEUES) stalling alone never
//      moves `level` -- it's still reported via queue.stalledLowPriority.
//   4. otherwise                                   -> "ok".
// REST p95/error-rate are trusted only once sampleCount >=
// MIN_REST_SAMPLES_FOR_SIGNAL (computeRestStats already nulls them out
// below that, and an "insufficient data" note is added here).
// attribution (see deriveAttribution) is derived from the SAME inputs after
// `level`/`discordLevel`/the non-exempt stall list are known, so it can
// never disagree with what `level` actually says.
export function deriveHealth(inputs: HealthSampleInputs, checkedAt: Date): BotHealth {
  const notes: string[] = [];
  const { gatewayPingMs, restP95Ms, restErrorRate, sampleCount } = inputs.discord;

  if (sampleCount < MIN_REST_SAMPLES_FOR_SIGNAL) {
    notes.push(`Discord REST: insufficient data (${sampleCount} sample${sampleCount === 1 ? "" : "s"} so far).`);
  }

  let discordLevel: HealthLevel = "ok";
  if (restP95Ms !== null && restP95Ms > REST_P95_DEGRADED_MS) {
    discordLevel = "degraded";
    notes.push(`Discord REST is slow: p95 ${Math.round(restP95Ms)}ms (over ${REST_P95_DEGRADED_MS}ms).`);
  }
  if (restErrorRate !== null && restErrorRate > REST_ERROR_RATE_DEGRADED) {
    discordLevel = "degraded";
    notes.push(
      `Discord REST error rate ${(restErrorRate * 100).toFixed(1)}% (over ${(REST_ERROR_RATE_DEGRADED * 100).toFixed(0)}%).`,
    );
  }
  if (gatewayPingMs !== null && gatewayPingMs > GATEWAY_PING_DEGRADED_MS) {
    discordLevel = "degraded";
    notes.push(`Discord gateway ping ${Math.round(gatewayPingMs)}ms (over ${GATEWAY_PING_DEGRADED_MS}ms).`);
  }

  const nonExemptStalled = inputs.queue.stalled.filter((name) => !isAlertExemptQueue(name));
  const exemptStalled = inputs.queue.stalled.filter((name) => isAlertExemptQueue(name));
  const queueOk = nonExemptStalled.length === 0;
  if (!queueOk) {
    notes.push(`Stalled queue(s): ${nonExemptStalled.join(", ")}.`);
  }

  let level: HealthLevel;
  if (!inputs.db.ok) {
    level = "down";
    notes.unshift("Database is unreachable.");
  } else if (discordLevel === "degraded" || !queueOk) {
    level = "degraded";
  } else {
    level = "ok";
  }

  if (notes.length === 0) notes.push("All systems normal.");

  const attribution = deriveAttribution({
    db: { ok: inputs.db.ok },
    discord: { level: discordLevel },
    queue: { stalled: nonExemptStalled },
    discordStatus: inputs.discordStatus,
  });

  return {
    level,
    checkedAt,
    discord: { gatewayPingMs, restP95Ms, restErrorRate, level: discordLevel },
    db: { latencyMs: inputs.db.latencyMs, ok: inputs.db.ok },
    queue: { stalled: nonExemptStalled, stalledLowPriority: exemptStalled, ok: queueOk },
    notes,
    discordStatus: inputs.discordStatus,
    attribution,
  };
}

// -- Attribution (pure) ------------------------------------------------------

export interface AttributionInputs {
  db: { ok: boolean };
  discord: { level: HealthLevel };
  // Non-exempt stalled queue names ONLY (the same list that drives `level`)
  // -- an alert-exempt-only stall must never move attribution to "queue".
  queue: { stalled: string[] };
  discordStatus: DiscordStatusInfo | null;
}

// PURE. Best-guess "whose fault is this" for the admin surfaces (never the
// public embed). Priority mirrors deriveHealth's own level priority so the
// two can never tell a different story:
//   1. db not ok                                            -> "database"
//   2. discord.level !== "ok" AND discordStatus reports a
//      real incident (indicator !== "none")                 -> "discord"
//   3. discord.level !== "ok" AND discordStatus says
//      operational (indicator === "none")                    -> "network"
//      (their status page disagrees with what we're seeing --
//      most likely OUR egress, not Discord itself)
//   4. discord.level !== "ok" AND discordStatus is null
//      (unreachable / never polled)                          -> "unknown"
//   5. only non-exempt queues stalled (db/discord both fine)  -> "queue"
//   6. otherwise                                              -> "none"
export function deriveAttribution(inputs: AttributionInputs): Attribution {
  if (!inputs.db.ok) return "database";
  if (inputs.discord.level !== "ok") {
    if (inputs.discordStatus === null) return "unknown";
    return inputs.discordStatus.indicator !== "none" ? "discord" : "network";
  }
  if (inputs.queue.stalled.length > 0) return "queue";
  return "none";
}

// PURE. Plain-language "likely cause" line for ADMIN surfaces ONLY --
// health-broadcast.ts's devops alert and bot-status-content.ts's
// buildHealthEmbed. Never call this from buildPublicHealthEmbed.
export function describeAttribution(attribution: Attribution, discordStatus: DiscordStatusInfo | null): string {
  switch (attribution) {
    case "database":
      return "Our database is unreachable.";
    case "discord":
      return `Discord-side incident (confirmed by discordstatus.com)${discordStatus ? ` -- ${discordStatus.description}.` : "."}`;
    case "network":
      return "Discord reports normal -- likely our network egress, not Discord.";
    case "unknown":
      return "Discord looks degraded, but discordstatus.com couldn't be reached to confirm either way.";
    case "queue":
      return "A background queue is stalled (not player-impacting).";
    case "none":
      return "No specific cause -- systems normal.";
  }
}

// -- Shell: rolling window storage + the seam rate-limit-logger.ts feeds --

const REST_WINDOW_SIZE = 200;
const restWindow: RestSample[] = [];

// The smallest possible seam into the rolling window -- called from
// attachRestTiming()'s existing request wrapper (rate-limit-logger.ts) on
// every Discord REST call. Never throws, never awaits; a plain array push.
export function recordDiscordRestSample(durationMs: number, ok: boolean): void {
  restWindow.push({ durationMs, ok });
  if (restWindow.length > REST_WINDOW_SIZE) restWindow.shift();
}

// -- Shell: the 60s tick, presence, and cache -------------------------------

let cachedHealth: BotHealth | null = null;
let lastPresenceKey: string | null = null;
let started = false;
// The level from the PREVIOUS tick -- null until the first tick completes,
// which is exactly what keeps the boot/redeploy tick from firing a
// transition broadcast (see health-broadcast.ts's classifyTransition).
let previousHealthLevel: HealthLevel | null = null;

const TICK_INTERVAL_MS = 60_000;

// What the /league-bot-status command reads. Never re-runs checks.
export function getCachedHealth(): BotHealth | null {
  return cachedHealth;
}

async function measureDbLatency(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    console.warn("[bot-health] db check failed:", err);
    return { ok: false, latencyMs: Date.now() - start };
  }
}

// PURE. checkQueueStalls() flags a queue once its OLDEST job has sat past
// STALL_THRESHOLD_SECONDS in devops-alarm.ts -- which false-positives on a
// queue that's merely throttled-but-draining: e.g. snapshot.mmr sitting at
// 682 completed / 36 queued and visibly shrinking (37 -> 36) tick to tick
// still has an oldest job old enough to trip that threshold. A queue only
// counts as GENUINELY stalled for health-level purposes when it is NOT
// making progress: its queued job count is non-decreasing since the
// previous tick. previousCounts holds each queue's jobCount as of the last
// tick; a queue with no prior entry (first time it's ever been reported
// stalled) is kept -- conservative, matches the pre-existing behavior for a
// newly-stalled queue.
export interface QueueStallCandidate {
  name: string;
  jobCount: number;
}

export function filterGenuinelyStalled(
  candidates: readonly QueueStallCandidate[],
  previousCounts: ReadonlyMap<string, number>,
): QueueStallCandidate[] {
  return candidates.filter((c) => {
    const prev = previousCounts.get(c.name);
    return prev === undefined || c.jobCount >= prev;
  });
}

// -- Shell: tick-to-tick queued-count memory for filterGenuinelyStalled ---

// name -> jobCount as of the last tick's checkQueueStalls() result.
// Repopulated wholesale from THIS tick's raw result every call (not just the
// genuinely-stalled subset), so a queue that drops off the stalled list
// entirely (recovers) naturally falls out of this map too -- no separate
// cleanup needed, and a queue that starts stalling again later is treated as
// newly-seen (conservative, per filterGenuinelyStalled's doc above).
const previousQueueJobCounts = new Map<string, number>();

// checkQueueStalls() already runs on its own 5min pg-boss schedule
// (queue.ts) with its own post-cooldown -- calling it again here is a
// cheap read-only query and shares that same cooldown state, so it never
// double-posts. Its raw result is further filtered by filterGenuinelyStalled
// (above) so this health check's "stalled" verdict doesn't false-positive on
// a queue that's merely throttled-but-draining. If it throws, this degrades
// gracefully to "no stalls seen".
async function gatherStalledQueueNames(): Promise<string[]> {
  try {
    const result = await checkQueueStalls();
    const genuinelyStalled = filterGenuinelyStalled(result.stalled, previousQueueJobCounts);
    previousQueueJobCounts.clear();
    for (const s of result.stalled) previousQueueJobCounts.set(s.name, s.jobCount);
    return genuinelyStalled.map((s) => s.name);
  } catch (err) {
    console.warn("[bot-health] queue stall check failed:", err);
    return [];
  }
}

function gatewayPingMs(client: Client): number | null {
  const ping = client.ws.ping;
  return Number.isFinite(ping) && ping >= 0 ? ping : null;
}

// Discord's activity text is small real estate -- collapse a note down to a
// short cause phrase instead of showing the full sentence.
function shortenPresenceText(note: string): string {
  if (note.startsWith("Discord REST is slow") || note.startsWith("Discord gateway ping")) return "Discord is slow";
  if (note.startsWith("Discord REST error rate")) return "Discord API errors";
  if (note.startsWith("Stalled queue")) return "queue delayed";
  return note.length > 60 ? `${note.slice(0, 57)}...` : note;
}

async function presenceFor(health: BotHealth): Promise<{ status: "online" | "idle" | "dnd"; activityName: string }> {
  if (health.level === "down") {
    return { status: "dnd", activityName: "degraded -- admins notified" };
  }
  if (health.level === "degraded") {
    const cause = health.notes.find((n) => n !== "All systems normal.") ?? "needs attention";
    return { status: "idle", activityName: shortenPresenceText(cause) };
  }
  const season = await activePublicSeason().catch(() => null);
  return { status: "online", activityName: season ? formatSeasonLabel(season) : "/help" };
}

// Discord rate-limits presence updates (~5/min) -- only call setPresence
// when the rendered status+text actually changed since the last tick.
async function updatePresence(client: Client, health: BotHealth): Promise<void> {
  if (!client.user) return;
  const { status, activityName } = await presenceFor(health);
  const key = `${status}|${activityName}`;
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  client.user.setPresence({
    status,
    activities: [{ name: activityName, type: ActivityType.Watching }],
  });
}

async function runHealthTick(client: Client): Promise<void> {
  // fetchDiscordStatus is internally cache-throttled (DISCORD_STATUS_CACHE_MS
  // in discord-status.ts) so calling it every 60s tick is cheap -- most
  // calls are a cache hit, not a real network request.
  const [db, stalled, discordStatus] = await Promise.all([
    measureDbLatency(),
    gatherStalledQueueNames(),
    fetchDiscordStatus(),
  ]);
  const restStats = computeRestStats(restWindow);
  const inputs: HealthSampleInputs = {
    db,
    discord: { gatewayPingMs: gatewayPingMs(client), ...restStats },
    queue: { stalled },
    discordStatus,
  };
  const prevLevel = previousHealthLevel;
  cachedHealth = deriveHealth(inputs, new Date());
  previousHealthLevel = cachedHealth.level;
  // Fire-and-forget, best-effort -- must never delay or break the tick or
  // the presence update below. onHealthTransition guards every step
  // internally, but the .catch() here is defense in depth.
  void onHealthTransition(client, prevLevel, cachedHealth.level, cachedHealth).catch((err) => {
    console.warn("[bot-health] health transition broadcast failed:", err);
  });
  // Fire-and-forget, best-effort, same as above -- refreshBotStatusMessage
  // internally throttles on its own render key, so most of these calls are a
  // cheap no-op edit-skip. This runs on EVERY tick, which already covers a
  // level transition (ok<->degraded/down): the render key changes the
  // instant `level` changes, in this same tick, so the channel message
  // updates on the transition edge without a separate call from
  // health-broadcast.ts (which would otherwise import this module and
  // create a cycle back into bot-health.ts).
  void refreshBotStatusMessage(cachedHealth).catch((err) => {
    console.warn("[bot-health] bot-status channel refresh failed:", err);
  });
  await updatePresence(client, cachedHealth).catch((err) => {
    console.warn("[bot-health] presence update failed:", err);
  });
}

// Kick off the 60s health-check loop. Best-effort -- a failed tick degrades
// the cached snapshot gracefully and never throws out of this function or
// crashes boot. Idempotent (a second call is a no-op) so it's safe to wire
// alongside the other start* calls in index.ts even if boot logic changes.
export function startBotHealth(client: Client): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runHealthTick(client).catch((err) => {
      console.warn("[bot-health] tick failed unexpectedly:", err);
    });
  };
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
