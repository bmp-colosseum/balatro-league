// Degradation broadcast layer for bot-health.ts. When the health monitor
// transitions ok -> degraded/down, tell the owner (devops alert, always) and,
// when the incident is PLAYER-IMPACTING (isPlayerImpacting -- db down or
// Discord itself slow/erroring), players too (a banner on the pinned
// #league-matches message + a heads-up in every live match thread). An
// internal-only incident (e.g. a backlogged pg-boss queue with Discord/db
// fine) stays devops-only -- players were never shown anything, so there's
// nothing to alarm them with. When it recovers back to ok, undo whatever was
// actually applied.
//
// EDGE-TRIGGERED ONLY: the tick that calls onHealthTransition runs every
// 60s, but a broadcast only fires on the two transition edges (see
// classifyTransition) -- a multi-hour outage produces exactly one round of
// notices on the way down and one on the way back up, never one per tick.
//
// Pure/shell split: classifyTransition, ownerAllowedMentions, and the
// buildXxx text builders are the pure core (plain data in, plain data out --
// no Discord/DB I/O, unit-tested with zero mocks). onHealthTransition and
// everything below it is the thin imperative shell: gather the live-thread
// session ids, call the pure builders for content, then perform the Discord
// writes. Every Discord/DB call in the shell is try/catch or .catch()
// guarded so a failure in one step (devops post, banner edit, one thread
// post) never aborts the others and never throws back into the health tick.

import type { Client, MessageMentionOptions } from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { postDevopsAlert } from "./devops-alert.js";
import { ensureLeagueMatchesMessage } from "./league-matches-message.js";
import { logDiscordError } from "./log-discord-error.js";
import { describeAttribution, type BotHealth, type HealthLevel } from "./bot-health.js";

// -- Pure core ---------------------------------------------------------------

export type HealthTransition = "none" | "degraded" | "recovered";

// PURE. Maps a (previous level, new level) pair to what broadcast (if any)
// should fire. Rules:
//   null -> anything        : "none"      (first tick after boot -- never
//                                          alert on a fresh process/deploy)
//   ok -> degraded|down     : "degraded"  (entering an incident)
//   degraded|down -> ok     : "recovered" (leaving an incident)
//   degraded <-> down       : "none"      (already mid-incident, severity
//                                          wobbling -- don't re-broadcast)
//   same -> same            : "none"
export function classifyTransition(prev: HealthLevel | null, next: HealthLevel): HealthTransition {
  if (prev === null) return "none";
  const wasHealthy = prev === "ok";
  const isHealthy = next === "ok";
  if (wasHealthy && !isHealthy) return "degraded";
  if (!wasHealthy && isHealthy) return "recovered";
  return "none";
}

// PURE. Discord allowedMentions that pings ONLY the owner (when configured)
// and nothing else -- no @everyone/@here, no role pings riding along on a
// mention embedded in alert content.
export function ownerAllowedMentions(ownerDiscordId: string | undefined): MessageMentionOptions {
  return ownerDiscordId ? { parse: [], users: [ownerDiscordId] } : { parse: [] };
}

function fmtMs(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v)}ms`;
}

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

// PURE. True when a player would actually FEEL something is wrong -- the
// database being unreachable (matches/reporting/commands all break) or
// Discord's own gateway/REST being slow or erroring (buttons/results lag or
// look stuck). A queue backlog ALONE is invisible to players: results still
// land, just slightly delayed by a background worker draining its list --
// so it does NOT count on its own. onHealthTransition below uses this to
// decide whether an incident gets the banner + thread notices, or stays a
// devops-only heads-up; bot-status-content.ts's buildPublicHealthEmbed uses
// the same function so the player-facing status message can never claim a
// different story than what actually got broadcast to players.
export function isPlayerImpacting(health: BotHealth): boolean {
  return health.db.ok === false || health.discord.level !== "ok";
}

// PURE. #devops content for the "we just went degraded/down" post. Starts
// with the owner mention (when configured) so it actually pings per
// ownerAllowedMentions above; when unset, the alert still posts, just
// without a mention. The closing line only claims a player-facing banner/
// thread notices were shown when isPlayerImpacting(health) says they
// actually were (see onHealthTransition, which gates the real actions on
// the same rule) -- an internal-only incident (e.g. a backlogged queue)
// says so plainly instead.
export function buildDegradedAlertContent(health: BotHealth, ownerDiscordId: string | undefined): string {
  const mention = ownerDiscordId ? `<@${ownerDiscordId}> ` : "";
  const lines = [
    `${mention}:rotating_light: **Bot health is now \`${health.level}\`**`,
    "",
    ...health.notes.map((n) => `- ${n}`),
    "",
    `Likely cause: ${describeAttribution(health.attribution, health.discordStatus)}`,
    "",
    `Discord: gateway ${fmtMs(health.discord.gatewayPingMs)} | REST p95 ${fmtMs(health.discord.restP95Ms)} | REST error rate ${fmtPct(health.discord.restErrorRate)}`,
    `DB latency: ${fmtMs(health.db.latencyMs)}`,
    `Stalled queue(s): ${health.queue.stalled.length > 0 ? health.queue.stalled.join(", ") : "none"}`,
    "",
    isPlayerImpacting(health)
      ? "Players have been shown a heads-up banner on #league-matches and a notice in their live match threads."
      : "Internal only -- no player-facing notices sent. Matches are unaffected.",
  ];
  return lines.join("\n");
}

// PURE. #devops content for the "back to ok" post. `playerImpacting` is the
// CALLER's job to supply (see sendDevopsRecoveredAlert) -- by the time this
// runs, `health` itself is already back to `ok`, so isPlayerImpacting(health)
// would always read false; the caller passes what was actually true DURING
// the incident (health-broadcast.ts's sticky playerNoticesApplied tracking).
export function buildRecoveredAlertContent(
  health: BotHealth,
  ownerDiscordId: string | undefined,
  playerImpacting: boolean,
): string {
  const mention = ownerDiscordId ? `<@${ownerDiscordId}> ` : "";
  return [
    `${mention}:white_check_mark: **Bot health has recovered -- back to \`ok\`.**`,
    `Checked at ${health.checkedAt.toISOString()}.`,
    playerImpacting
      ? "Player-facing notices (banner + thread notes) have been cleared."
      : "Internal only -- no player-facing notices were sent, so there was nothing to clear.",
  ].join("\n");
}

// The #league-matches pinned message gets this line prepended while
// degraded, then goes back to exactly its normal content on recovery (see
// ensureLeagueMatchesMessage's optional banner param).
export const DEGRADED_BANNER_LINE =
  "> :warning: **Discord is having issues right now** -- starting and reporting matches may be slow or look stuck. Your clicks are still landing.";

// PURE. Per-thread notices posted to live MatchSessions during an incident.
export function buildThreadDegradedNotice(): string {
  return (
    ":warning: Heads up -- Discord itself is having issues right now (not this match). Bot responses in " +
    "this thread may be slow or look stuck; your clicks/reports are still landing, just give it a moment."
  );
}

export function buildThreadRecoveredNotice(): string {
  return ":white_check_mark: Discord's issues have cleared -- everything should be responsive again now.";
}

// -- Shell: thread discovery + throttled posting -----------------------------

// Cap on how many live match threads get a notice per incident, so a big
// season doesn't hammer the REST API during an incident that is ALREADY
// about REST slowness. THREAD_POST_DELAY_MS sequences the posts instead of
// firing them concurrently, for the same reason.
const MAX_INCIDENT_THREADS = 25;
const THREAD_POST_DELAY_MS = 250;

// In-memory, per-process: the MatchSession ids notified for the CURRENT
// incident. Populated on the "degraded" edge, drained (and posted an
// all-clear) on the "recovered" edge. A tick landing mid-incident never
// re-populates ids already in here, so repeated ticks during a long outage
// can't double-post to the same thread.
let notifiedThreadSessionIds = new Set<string>();
let currentIncidentId: string | null = null;
// Sticky per-incident flag: true once ANY tick during the current incident
// was player-impacting (isPlayerImpacting), updated every tick in
// onHealthTransition -- not just on the transition edges. That's what makes
// it restart-safe: even if the process restarts mid-incident (losing the
// in-memory value), the very next tick re-derives it from the LIVE snapshot
// before recovery can ever be classified, so a real player-facing banner can
// never end up permanently un-clearable. Gates the recovery-side clear
// below; only resets to false once that clear has actually run. The clear
// calls themselves (setLeagueMatchesBanner/broadcastRecoveredToThreads) are
// also cheap, idempotent no-ops when there's nothing to undo, so being wrong
// in either direction here costs nothing.
let playerNoticesApplied = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLiveThreadSessions(limit: number): Promise<{ id: string; threadId: string }[]> {
  const rows = await prisma.matchSession.findMany({
    where: {
      threadId: { not: null },
      state: { notIn: ["COMPLETE", "CANCELLED"] },
    },
    select: { id: true, threadId: true },
    take: limit + 1, // +1 so we can tell "more than the cap exist" without a separate count query
  });
  return rows.flatMap((r) => (r.threadId ? [{ id: r.id, threadId: r.threadId }] : []));
}

async function postToThread(client: Client, threadId: string, content: string, sessionId: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(threadId);
    if (!channel || !("send" in channel)) return;
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    logDiscordError("health-broadcast.postToThread", err, { threadId, sessionId });
  }
}

async function broadcastDegradedToThreads(client: Client): Promise<void> {
  let sessions: { id: string; threadId: string }[];
  try {
    sessions = await findLiveThreadSessions(MAX_INCIDENT_THREADS);
  } catch (err) {
    console.warn("[health-broadcast] failed to load live match threads:", err);
    return;
  }
  if (sessions.length > MAX_INCIDENT_THREADS) {
    console.warn(
      `[health-broadcast] ${sessions.length - MAX_INCIDENT_THREADS} live match thread(s) skipped (cap ${MAX_INCIDENT_THREADS})`,
    );
  }
  const capped = sessions.slice(0, MAX_INCIDENT_THREADS);
  const notice = buildThreadDegradedNotice();
  for (const session of capped) {
    if (notifiedThreadSessionIds.has(session.id)) continue; // already notified this incident
    await postToThread(client, session.threadId, notice, session.id);
    notifiedThreadSessionIds.add(session.id);
    await sleep(THREAD_POST_DELAY_MS);
  }
}

async function broadcastRecoveredToThreads(client: Client): Promise<void> {
  const sessionIds = [...notifiedThreadSessionIds];
  if (sessionIds.length === 0) return;
  let sessions: { id: string; threadId: string | null }[];
  try {
    sessions = await prisma.matchSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, threadId: true },
    });
  } catch (err) {
    console.warn("[health-broadcast] failed to load notified threads for recovery notice:", err);
    notifiedThreadSessionIds.clear();
    return;
  }
  const notice = buildThreadRecoveredNotice();
  for (const session of sessions) {
    if (!session.threadId) continue;
    await postToThread(client, session.threadId, notice, session.id);
    await sleep(THREAD_POST_DELAY_MS);
  }
  notifiedThreadSessionIds.clear();
}

// -- Shell: devops alert + #league-matches banner ----------------------------

async function sendDevopsDegradedAlert(health: BotHealth): Promise<void> {
  try {
    const content = buildDegradedAlertContent(health, env.LEAGUE_OWNER_DISCORD_ID);
    await postDevopsAlert(content, false, ownerAllowedMentions(env.LEAGUE_OWNER_DISCORD_ID));
  } catch (err) {
    console.warn("[health-broadcast] devops degraded alert failed:", err);
  }
}

async function sendDevopsRecoveredAlert(health: BotHealth, playerImpacting: boolean): Promise<void> {
  try {
    const content = buildRecoveredAlertContent(health, env.LEAGUE_OWNER_DISCORD_ID, playerImpacting);
    await postDevopsAlert(content, false, ownerAllowedMentions(env.LEAGUE_OWNER_DISCORD_ID));
  } catch (err) {
    console.warn("[health-broadcast] devops recovered alert failed:", err);
  }
}

async function setLeagueMatchesBanner(client: Client, banner: string | undefined): Promise<void> {
  try {
    await ensureLeagueMatchesMessage(client, banner);
  } catch (err) {
    console.warn("[health-broadcast] #league-matches banner update failed:", err);
  }
}

function logSettledFailures(label: string, results: PromiseSettledResult<void>[]): void {
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[health-broadcast] ${label} step failed unexpectedly:`, r.reason);
    }
  }
}

// -- Shell: the hook bot-health.ts's tick calls -------------------------------

// Called from runHealthTick after computing the new snapshot. Never throws
// (every awaited step is individually guarded, and Promise.allSettled means
// an unexpected throw in one branch still lets the others run) -- callers
// should still `.catch()` it defensively, but it's not required for
// correctness.
export async function onHealthTransition(
  client: Client,
  prev: HealthLevel | null,
  next: HealthLevel,
  health: BotHealth,
): Promise<void> {
  // Track player-impact for the CURRENT incident on every tick this function
  // is called (bot-health.ts's runHealthTick calls it every 60s regardless
  // of transition) -- see playerNoticesApplied's comment for why this must
  // happen before the "none" early-return below, not only on the "degraded"
  // edge.
  if (next !== "ok" && isPlayerImpacting(health)) {
    playerNoticesApplied = true;
  }

  const transition = classifyTransition(prev, next);
  if (transition === "none") return;

  if (transition === "degraded") {
    const playerImpacting = isPlayerImpacting(health);
    currentIncidentId = health.checkedAt.toISOString();
    notifiedThreadSessionIds.clear();
    console.warn(
      `[health-broadcast] incident ${currentIncidentId} started (level=${next}, playerImpacting=${playerImpacting})`,
    );
    const tasks: Promise<void>[] = [sendDevopsDegradedAlert(health)];
    // Banner + thread notices only for incidents a player would actually
    // notice -- a stalled queue alone stays devops-only.
    if (playerImpacting) {
      tasks.push(setLeagueMatchesBanner(client, DEGRADED_BANNER_LINE), broadcastDegradedToThreads(client));
    }
    const results = await Promise.allSettled(tasks);
    logSettledFailures("degraded broadcast", results);
    return;
  }

  // "recovered" -- devops always hears about it. The player-facing clear
  // (banner + thread all-clears) only runs when notices were actually
  // applied at some point during this incident (playerNoticesApplied).
  const tasks: Promise<void>[] = [sendDevopsRecoveredAlert(health, playerNoticesApplied)];
  if (playerNoticesApplied) {
    tasks.push(setLeagueMatchesBanner(client, undefined), broadcastRecoveredToThreads(client));
  }
  const results = await Promise.allSettled(tasks);
  logSettledFailures("recovered broadcast", results);
  console.warn(
    `[health-broadcast] incident ${currentIncidentId ?? "(unknown)"} recovered (playerNoticesApplied=${playerNoticesApplied})`,
  );
  currentIncidentId = null;
  playerNoticesApplied = false;
}
