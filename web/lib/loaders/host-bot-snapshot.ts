import "server-only";

// Cross-container fetch of the bot's health snapshot for the owner-facing
// /admin/host page. The web app and the bot are SEPARATE Docker containers
// (see .github/workflows/deploy.yml -- "league-web" and "league-bot" are
// rolled independently), so this can't just import src/bot-health.ts's
// in-memory cache; it has to hit the bot's HTTP endpoint over the compose
// network (src/healthcheck.ts serves it at :8080/health/status).
//
// Hostname resolution: BOT_HEALTH_URL env var first, falling back to the
// compose service name the bot is deployed under ("league-bot", per
// deploy.yml's `docker compose ... up -d league-bot`) on its healthcheck
// port (8080, per Dockerfile.league-bot). The compose file itself lives in
// the separate infra repo (bmp-colosseum-infra), not here.
//
// Never throws: an unreachable/slow/malformed bot response is itself useful
// information ("the bot isn't reachable from web") and must render fine,
// not crash the page.

const DEFAULT_BOT_HEALTH_URL = "http://league-bot:8080/health/status";
const FETCH_TIMEOUT_MS = 2500;

export type BotHealthLevel = "ok" | "degraded" | "down";

export interface BotHealthSnapshot {
  level: BotHealthLevel;
  checkedAt: string; // ISO timestamp -- JSON.stringify(Date) on the bot side
  discord: {
    gatewayPingMs: number | null;
    restP95Ms: number | null;
    restErrorRate: number | null;
    level: BotHealthLevel;
  };
  db: { latencyMs: number | null; ok: boolean };
  queue: { stalled: string[]; ok: boolean };
  notes: string[];
}

export interface BotSnapshotResult {
  snapshot: BotHealthSnapshot | null;
  error: string | null;
}

function isHealthLevel(value: unknown): value is BotHealthLevel {
  return value === "ok" || value === "degraded" || value === "down";
}

// Narrow the fetched JSON before trusting its shape -- this crosses a
// network boundary to a separate service/repo, so `unknown` + a guard
// (never `any`) is the only honest way to consume it.
function isBotHealthSnapshot(value: unknown): value is BotHealthSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isHealthLevel(v.level) || typeof v.checkedAt !== "string") return false;
  const discord = v.discord as Record<string, unknown> | undefined;
  if (
    typeof discord !== "object" ||
    discord === null ||
    !isHealthLevel(discord.level) ||
    !(typeof discord.gatewayPingMs === "number" || discord.gatewayPingMs === null) ||
    !(typeof discord.restP95Ms === "number" || discord.restP95Ms === null) ||
    !(typeof discord.restErrorRate === "number" || discord.restErrorRate === null)
  ) {
    return false;
  }
  const db = v.db as Record<string, unknown> | undefined;
  if (typeof db !== "object" || db === null || typeof db.ok !== "boolean") return false;
  if (!(typeof db.latencyMs === "number" || db.latencyMs === null)) return false;
  const queue = v.queue as Record<string, unknown> | undefined;
  if (typeof queue !== "object" || queue === null || typeof queue.ok !== "boolean" || !Array.isArray(queue.stalled)) {
    return false;
  }
  return Array.isArray(v.notes);
}

export async function loadBotHealthSnapshot(): Promise<BotSnapshotResult> {
  const url = process.env.BOT_HEALTH_URL ?? DEFAULT_BOT_HEALTH_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const errText =
        body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      return { snapshot: null, error: `bot health endpoint returned ${res.status}: ${errText}` };
    }
    if (!isBotHealthSnapshot(body)) {
      return { snapshot: null, error: "bot health endpoint returned an unexpected shape" };
    }
    return { snapshot: body, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = controller.signal.aborted ? `timed out after ${FETCH_TIMEOUT_MS}ms` : message;
    return { snapshot: null, error: `could not reach bot health endpoint (${url}): ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}
