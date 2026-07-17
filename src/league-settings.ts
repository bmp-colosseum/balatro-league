// Reads the league rules. Scoring (3/1/0) and ban/pick policy
// (4/3/9/2) are HARDCODED constants — not configurable from the UI.
// LeagueRulesTemplate now only carries the two timeout fields
// (matchInviteExpiryMinutes, reportAutoConfirmSeconds); templates
// still exist so a season can opt into different timeouts via
// Season.leagueRulesTemplateId.
//
// Match sessions stamp their policy at accept time so in-flight games
// don't break when an admin edits or swaps templates mid-season.

import type { LeagueRulesTemplate } from "@prisma/client";
import { prisma } from "./db.js";
import { cacheEventsTotal } from "./metrics.js";

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
// Per-season cache. Default template is stored under "" so a single
// Map covers both code paths.
const cache = new Map<string, { value: LeagueSettings; expiresAt: number }>();

export async function getLeagueSettings(): Promise<LeagueSettings> {
  const key = "";
  const c = cache.get(key);
  if (c && c.expiresAt > Date.now()) {
    cacheEventsTotal.inc({ cache: "league_settings", result: "hit" });
    return c.value;
  }
  cacheEventsTotal.inc({ cache: "league_settings", result: "miss" });
  const template = await prisma.leagueRulesTemplate.findFirst({ where: { isDefault: true } });
  const value = templateToSettings(template);
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function getLeagueSettingsForSeason(seasonId: string): Promise<LeagueSettings> {
  const c = cache.get(seasonId);
  if (c && c.expiresAt > Date.now()) {
    cacheEventsTotal.inc({ cache: "league_settings", result: "hit" });
    return c.value;
  }
  cacheEventsTotal.inc({ cache: "league_settings", result: "miss" });
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { leagueRulesTemplate: true },
  });
  const template = season?.leagueRulesTemplate
    ?? await prisma.leagueRulesTemplate.findFirst({ where: { isDefault: true } });
  const value = templateToSettings(template);
  cache.set(seasonId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidateLeagueSettingsCache(): void {
  cache.clear();
}

function templateToSettings(template: LeagueRulesTemplate | null | undefined): LeagueSettings {
  if (!template) return DEFAULTS;
  return {
    scoring: DEFAULTS.scoring,
    matchPolicy: DEFAULTS.matchPolicy,
    matchInviteExpiryMinutes: template.matchInviteExpiryMinutes,
    reportAutoConfirmSeconds: template.reportAutoConfirmSeconds,
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
