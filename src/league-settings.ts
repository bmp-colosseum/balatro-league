// Cached reader for the tunable league rules (scoring, ban policy,
// timeouts, pool size). Each getter:
//   1. Reads from LeagueConfig (string → int)
//   2. Falls back to the typed default if unset or unparseable
//   3. Caches the full settings bundle in-memory with a short TTL so
//      hot paths (standings recompute, phaseFor on every button click)
//      don't hammer the DB
//
// TTL is 30s — admin changes propagate fast enough that league play
// isn't disrupted, and the cache eats ~all reads during a standings
// recompute or a multi-step ban/pick interaction.
//
// On schema-config-out-of-range (e.g. someone sets MatchPoolSize=2 and
// FirstPlayerBans=4), we log a warning and fall back to defaults rather
// than crash the match flow.

import { prisma } from "./db.js";
import { LeagueConfigKey } from "./league-config.js";

export interface ScoringConfig {
  pointsFor20Win: number;
  pointsFor11Draw: number;
  pointsForLoss: number;
}

export interface MatchPolicy {
  firstPlayerBans: number;
  secondPlayerBans: number;
  poolSize: number;
  // Derived: number of combos left after all bans. Useful for callers
  // who don't want to compute it themselves.
  picksFromRemaining: number;
}

export interface LeagueSettings {
  scoring: ScoringConfig;
  matchPolicy: MatchPolicy;
  matchInviteExpiryMinutes: number;
  reportAutoConfirmSeconds: number;
}

export const DEFAULTS: LeagueSettings = {
  scoring: {
    pointsFor20Win: 3,
    pointsFor11Draw: 1,
    pointsForLoss: 0,
  },
  matchPolicy: {
    firstPlayerBans: 4,
    secondPlayerBans: 3,
    poolSize: 9,
    picksFromRemaining: 2, // 9 - 4 - 3 = 2 combos, second player picks 1
  },
  matchInviteExpiryMinutes: 5,
  reportAutoConfirmSeconds: 120,
};

const TTL_MS = 30 * 1000;
let cache: { value: LeagueSettings; expiresAt: number } | null = null;

export async function getLeagueSettings(): Promise<LeagueSettings> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await readLeagueSettingsFresh();
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

// Bypasses the cache. Use after an admin write to make sure the next
// read reflects the change immediately.
export function invalidateLeagueSettingsCache(): void {
  cache = null;
}

async function readLeagueSettingsFresh(): Promise<LeagueSettings> {
  const rows = await prisma.leagueConfig.findMany({
    where: {
      key: {
        in: [
          LeagueConfigKey.PointsFor20Win,
          LeagueConfigKey.PointsFor11Draw,
          LeagueConfigKey.PointsForLoss,
          LeagueConfigKey.FirstPlayerBans,
          LeagueConfigKey.SecondPlayerBans,
          LeagueConfigKey.MatchPoolSize,
          LeagueConfigKey.MatchInviteExpiryMinutes,
          LeagueConfigKey.ReportAutoConfirmSeconds,
        ],
      },
    },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const readInt = (key: string, fallback: number, minInclusive: number): number => {
    const raw = byKey.get(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < minInclusive) {
      console.warn(`[league-settings] ${key}=${raw} out of range; using default ${fallback}`);
      return fallback;
    }
    return n;
  };
  const scoring: ScoringConfig = {
    pointsFor20Win: readInt(LeagueConfigKey.PointsFor20Win, DEFAULTS.scoring.pointsFor20Win, 0),
    pointsFor11Draw: readInt(LeagueConfigKey.PointsFor11Draw, DEFAULTS.scoring.pointsFor11Draw, 0),
    pointsForLoss: readInt(LeagueConfigKey.PointsForLoss, DEFAULTS.scoring.pointsForLoss, 0),
  };
  const firstBans = readInt(
    LeagueConfigKey.FirstPlayerBans,
    DEFAULTS.matchPolicy.firstPlayerBans,
    1,
  );
  const secondBans = readInt(
    LeagueConfigKey.SecondPlayerBans,
    DEFAULTS.matchPolicy.secondPlayerBans,
    0,
  );
  const poolSize = readInt(
    LeagueConfigKey.MatchPoolSize,
    DEFAULTS.matchPolicy.poolSize,
    3,
  );
  // Sanity: pool needs to leave at least 1 combo after all bans.
  // If the admin sets nonsense, drop back to defaults wholesale rather
  // than play with an unplayable pool.
  let matchPolicy: MatchPolicy;
  const remaining = poolSize - firstBans - secondBans;
  if (remaining < 1) {
    console.warn(
      `[league-settings] match policy invalid (pool ${poolSize}, first ${firstBans}, ` +
        `second ${secondBans} → ${remaining} left); falling back to defaults`,
    );
    matchPolicy = DEFAULTS.matchPolicy;
  } else {
    matchPolicy = {
      firstPlayerBans: firstBans,
      secondPlayerBans: secondBans,
      poolSize,
      picksFromRemaining: remaining,
    };
  }
  return {
    scoring,
    matchPolicy,
    matchInviteExpiryMinutes: readInt(
      LeagueConfigKey.MatchInviteExpiryMinutes,
      DEFAULTS.matchInviteExpiryMinutes,
      1,
    ),
    reportAutoConfirmSeconds: readInt(
      LeagueConfigKey.ReportAutoConfirmSeconds,
      DEFAULTS.reportAutoConfirmSeconds,
      0,
    ),
  };
}

// Compute points from a result given a scoring config. Stateless —
// callers fetch scoring once and reuse for a batch of pairings.
export function pointsFromGamesWithConfig(
  gamesWonSelf: number,
  gamesWonOpponent: number,
  scoring: ScoringConfig,
): number {
  if (gamesWonSelf === 2 && gamesWonOpponent === 0) return scoring.pointsFor20Win;
  if (gamesWonSelf === 1 && gamesWonOpponent === 1) return scoring.pointsFor11Draw;
  if (gamesWonSelf === 0 && gamesWonOpponent === 2) return scoring.pointsForLoss;
  return 0;
}
