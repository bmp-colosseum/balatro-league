// Pure decision core for GET /api/health -- the liveness probe the rolling
// league-web-a/league-web-b deploy waits on (see .github/workflows/deploy.yml and the
// Dockerfile HEALTHCHECK). The route shell (app/api/health/route.ts) does the only
// impure things -- a live `SELECT 1` (with one tolerant retry) and reading process
// uptime/env -- then hands plain values here so the status-code/body mapping is
// unit-testable without a database. Modeled directly on balatro-team-tour's
// apps/tour/lib/health-core.ts; keep the two in sync if the contract changes.
export interface HealthInput {
  dbReachable: boolean;
  sha: string;
  uptimeSeconds: number;
}

export interface HealthResult {
  status: 200 | 503;
  body: { ok: boolean; sha: string; uptimeSeconds: number } | { ok: false };
}

// Clamp defensively: a negative or fractional uptime should never leak out just because
// the caller's clock is briefly odd (e.g. right at process start).
function normalizeUptime(uptimeSeconds: number): number {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return 0;
  return Math.floor(uptimeSeconds);
}

export function buildHealthResult(input: HealthInput): HealthResult {
  const uptimeSeconds = normalizeUptime(input.uptimeSeconds);
  if (!input.dbReachable) {
    return { status: 503, body: { ok: false } };
  }
  return { status: 200, body: { ok: true, sha: input.sha, uptimeSeconds } };
}
