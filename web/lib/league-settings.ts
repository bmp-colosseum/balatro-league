// Web-side mirror of src/league-settings.ts. Same defaults, same cache
// TTL, same validation — keeps the two surfaces (Discord report flow,
// web report form + standings page) reading consistent rules.
//
// Two separate caches (one per Node process) is fine: TTL is short and
// admin writes call invalidateLeagueSettingsCache() on the side they
// wrote from. The other side picks up the change within TTL_MS.

import { prisma } from "@/lib/prisma";

const LeagueConfigKey = {
  PointsFor20Win: "points_for_2_0_win",
  PointsFor11Draw: "points_for_1_1_draw",
  PointsForLoss: "points_for_loss",
  FirstPlayerBans: "first_player_bans",
  SecondPlayerBans: "second_player_bans",
  MatchPoolSize: "match_pool_size",
  MatchInviteExpiryMinutes: "match_invite_expiry_minutes",
  ReportAutoConfirmSeconds: "report_auto_confirm_seconds",
} as const;

export interface ScoringConfig {
  pointsFor20Win: number;
  pointsFor11Draw: number;
  pointsForLoss: number;
}

export interface MatchPolicy {
  firstPlayerBans: number;
  secondPlayerBans: number;
  poolSize: number;
  picksFromRemaining: number;
}

export interface LeagueSettings {
  scoring: ScoringConfig;
  matchPolicy: MatchPolicy;
  matchInviteExpiryMinutes: number;
  reportAutoConfirmSeconds: number;
}

export const DEFAULTS: LeagueSettings = {
  scoring: { pointsFor20Win: 3, pointsFor11Draw: 1, pointsForLoss: 0 },
  matchPolicy: { firstPlayerBans: 4, secondPlayerBans: 3, poolSize: 9, picksFromRemaining: 2 },
  matchInviteExpiryMinutes: 5,
  reportAutoConfirmSeconds: 120,
};

const TTL_MS = 30 * 1000;
// Module-level cache survives hot-reload via globalThis (Next dev otherwise
// reinitializes it on every file change).
declare global {
  // eslint-disable-next-line no-var
  var __leagueSettingsCache: { value: LeagueSettings; expiresAt: number } | null | undefined;
}

export async function getLeagueSettings(): Promise<LeagueSettings> {
  const c = globalThis.__leagueSettingsCache;
  if (c && c.expiresAt > Date.now()) return c.value;
  const value = await readLeagueSettingsFresh();
  globalThis.__leagueSettingsCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export function invalidateLeagueSettingsCache(): void {
  globalThis.__leagueSettingsCache = null;
}

async function readLeagueSettingsFresh(): Promise<LeagueSettings> {
  const rows = await prisma.leagueConfig.findMany({
    where: { key: { in: Object.values(LeagueConfigKey) } },
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
  const firstBans = readInt(LeagueConfigKey.FirstPlayerBans, DEFAULTS.matchPolicy.firstPlayerBans, 1);
  const secondBans = readInt(LeagueConfigKey.SecondPlayerBans, DEFAULTS.matchPolicy.secondPlayerBans, 0);
  const poolSize = readInt(LeagueConfigKey.MatchPoolSize, DEFAULTS.matchPolicy.poolSize, 3);
  const remaining = poolSize - firstBans - secondBans;
  let matchPolicy: MatchPolicy;
  if (remaining < 1) {
    console.warn(
      `[league-settings] match policy invalid (pool ${poolSize}, first ${firstBans}, ` +
        `second ${secondBans}); falling back to defaults`,
    );
    matchPolicy = DEFAULTS.matchPolicy;
  } else {
    matchPolicy = { firstPlayerBans: firstBans, secondPlayerBans: secondBans, poolSize, picksFromRemaining: remaining };
  }
  return {
    scoring,
    matchPolicy,
    matchInviteExpiryMinutes: readInt(LeagueConfigKey.MatchInviteExpiryMinutes, DEFAULTS.matchInviteExpiryMinutes, 1),
    reportAutoConfirmSeconds: readInt(LeagueConfigKey.ReportAutoConfirmSeconds, DEFAULTS.reportAutoConfirmSeconds, 0),
  };
}

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
