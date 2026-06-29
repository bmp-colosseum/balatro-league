// Live read of the LEAGUE database — READ-ONLY, optional. When LEAGUE_DATABASE_URL
// is set (a `tour_ro` SELECT-only role), the Tour reads the league's `Player` table
// directly so identity-linking uses always-current Discord ids (no CSV export). If
// it's unset or the read fails, callers fall back to the uploaded LeagueRef / CSV.
//
// Uses a small `pg` pool (the Tour's Prisma client is for the Tour schema, so a raw
// connection is the clean way to read a DIFFERENT app's table). Results cached briefly.
import { Pool } from "pg";

export interface LeaguePlayer {
  discordId: string;
  name: string;
}

let pool: Pool | null = null;
function leaguePool(): Pool | null {
  if (!process.env.LEAGUE_DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.LEAGUE_DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      // Railway public proxy serves TLS; don't fail on the self-signed chain.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export const leagueDbConfigured = () => !!process.env.LEAGUE_DATABASE_URL;

let cache: { at: number; rows: LeaguePlayer[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

// The league's players as name→discordId rows — one for the display name and one
// for the Discord @username (so callers can match on either). Null when not
// configured; throws on a real connection/query error so the caller can fall back.
export async function leaguePlayersLive(): Promise<LeaguePlayer[] | null> {
  const p = leaguePool();
  if (!p) return null;
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;
  const res = await p.query<{ discordId: string; displayName: string; username: string | null }>(
    'SELECT "discordId", "displayName", "username" FROM "Player" WHERE "discordId" IS NOT NULL',
  );
  const rows: LeaguePlayer[] = [];
  for (const r of res.rows) {
    const discordId = String(r.discordId);
    if (!/^\d+$/.test(discordId)) continue;
    if (r.displayName) rows.push({ discordId, name: String(r.displayName) });
    if (r.username) rows.push({ discordId, name: String(r.username) });
  }
  cache = { at: now, rows };
  return rows;
}

let memberCache: { at: number; rows: LeaguePlayer[] } | null = null;

// The league's FULL Discord guild roster (the GuildMember table the league bot syncs),
// as name->id rows (username / global name / nickname). This is how we resolve people
// who AREN'T registered league players (tour-only members) — Discord has no public
// username->id lookup, so the shared guild's roster is the only source. Null when the
// league DB isn't configured; throws (caught by callers) if the table/permission isn't
// there yet, so the Tour degrades gracefully until the league side is deployed.
export async function leagueGuildMembers(): Promise<LeaguePlayer[] | null> {
  const p = leaguePool();
  if (!p) return null;
  const now = Date.now();
  if (memberCache && now - memberCache.at < TTL_MS) return memberCache.rows;
  const res = await p.query<{ discordId: string; username: string | null; globalName: string | null; nickname: string | null }>(
    'SELECT "discordId", "username", "globalName", "nickname" FROM "GuildMember"',
  );
  const rows: LeaguePlayer[] = [];
  for (const r of res.rows) {
    const discordId = String(r.discordId);
    if (!/^\d+$/.test(discordId)) continue;
    for (const n of [r.username, r.globalName, r.nickname]) if (n) rows.push({ discordId, name: String(n) });
  }
  memberCache = { at: now, rows };
  return rows;
}

// True if the league guild roster (GuildMember) is readable + populated. For diagnostics.
export async function leagueGuildMemberCount(): Promise<number | null> {
  const p = leaguePool();
  if (!p) return null;
  try {
    const res = await p.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM "GuildMember"');
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return null; // table/permission not there yet
  }
}

// Cheap connectivity check for diagnostics (true/false; never throws).
export async function leagueDbReachable(): Promise<boolean> {
  const p = leaguePool();
  if (!p) return false;
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
