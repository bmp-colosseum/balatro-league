// Fantasy scoring — pure core (ws08). Managers draft real players; each real set a
// rostered player plays scores fantasy points for that player's owner:
//   points(player) = gamesWon + (wonSet ? setWinPoints : 0)
// i.e. +1 per game won inside the set, +1 bonus for taking the set. So Chrono 2-1 Fey
// gives Chrono's owner 1+2 = 3 and Fey's owner 0+1 = 1 (a 2-0 sweep -> 3 and 0).
//
// No Prisma, no dates: the shell loads finished sets + the ownership map and calls these.
// The "out of playoffs = 0" rule is enforced upstream (the shell omits a player's sets once
// their real team is eliminated) so this core stays a pure function of the sets it's given.

export interface FantasyScoring {
  /** Points for taking the set (default 1). */
  setWinPoints: number;
  /** Points per game won inside the set (default 1). */
  gameWinPoints: number;
}

export const DEFAULT_FANTASY_SCORING: FantasyScoring = { setWinPoints: 1, gameWinPoints: 1 };

/** A finished set: the two real players and the games each won. Winner is derived. */
export interface SetOutcome {
  playerAId: string;
  playerBId: string;
  gamesA: number;
  gamesB: number;
}

/** One player's fantasy line from a single set. */
export interface PlayerSetPoints {
  playerId: string;
  gamesWon: number;
  wonSet: boolean;
  points: number;
}

/**
 * Score one finished set for its two players. A tie (equal games) awards neither the
 * set bonus; both still earn their game points. Negative games are clamped to 0.
 */
export function scoreSetForPlayers(
  set: SetOutcome,
  scoring: FantasyScoring = DEFAULT_FANTASY_SCORING,
): [PlayerSetPoints, PlayerSetPoints] {
  const a = Math.max(0, set.gamesA);
  const b = Math.max(0, set.gamesB);
  const aWon = a > b;
  const bWon = b > a;
  return [
    { playerId: set.playerAId, gamesWon: a, wonSet: aWon, points: a * scoring.gameWinPoints + (aWon ? scoring.setWinPoints : 0) },
    { playerId: set.playerBId, gamesWon: b, wonSet: bWon, points: b * scoring.gameWinPoints + (bWon ? scoring.setWinPoints : 0) },
  ];
}

export interface FantasyManagerTotal {
  managerId: string;
  points: number;
  sets: number;
}

/** A finished set enriched with each side's real team + intra-team seed slot. */
export interface SlottedSet extends SetOutcome {
  teamSeasonAId: string;
  seedA: number;
  teamSeasonBId: string;
  seedB: number;
}

/**
 * Resolve which fantasy manager a played set-side belongs to, honoring roster churn:
 *   1. identity first — if the player who actually played is a drafted (owned) player,
 *      credit their owner. This survives re-seeds (same person, different seed slot).
 *   2. slot fallback — otherwise the player is a sub / add / replacement, so credit
 *      whoever drafted that team's seed slot (the drafted player they filled in for).
 * Returns null when neither is owned (an undrafted player in an undrafted slot).
 */
export function resolveSlotOwner(
  playerId: string,
  teamSeasonId: string,
  seed: number,
  ownerByPlayer: (playerId: string) => string | null | undefined,
  ownerBySlot: (teamSeasonId: string, seed: number) => string | null | undefined,
): string | null {
  return ownerByPlayer(playerId) || ownerBySlot(teamSeasonId, seed) || null;
}

/**
 * Slot-aware tally: like {@link tallyFantasyPoints} but credits each side via
 * {@link resolveSlotOwner}, so a substitute's or replacement's points flow to whoever
 * drafted that roster slot. Deterministic (points desc, then id asc).
 */
export function tallyFantasyBySlot(
  sets: SlottedSet[],
  ownerByPlayer: (playerId: string) => string | null | undefined,
  ownerBySlot: (teamSeasonId: string, seed: number) => string | null | undefined,
  scoring: FantasyScoring = DEFAULT_FANTASY_SCORING,
): FantasyManagerTotal[] {
  const byManager = new Map<string, { points: number; sets: number }>();
  const credit = (mgr: string | null, points: number) => {
    if (!mgr) return;
    const cur = byManager.get(mgr) ?? { points: 0, sets: 0 };
    cur.points += points;
    cur.sets += 1;
    byManager.set(mgr, cur);
  };
  for (const set of sets) {
    const [a, b] = scoreSetForPlayers(set, scoring);
    credit(resolveSlotOwner(set.playerAId, set.teamSeasonAId, set.seedA, ownerByPlayer, ownerBySlot), a.points);
    credit(resolveSlotOwner(set.playerBId, set.teamSeasonBId, set.seedB, ownerByPlayer, ownerBySlot), b.points);
  }
  return [...byManager.entries()]
    .map(([managerId, v]) => ({ managerId, points: v.points, sets: v.sets }))
    .sort((x, y) => y.points - x.points || x.managerId.localeCompare(y.managerId));
}

/**
 * Tally fantasy points per manager over a batch of finished sets. `ownerOf` maps a real
 * player id to the fantasy manager who rostered them (null/undefined = undrafted, ignored).
 * Deterministic: managers are returned sorted by points desc, then id asc. Undrafted
 * players and self-owned-both-sides simply contribute to whichever manager owns each side.
 */
export function tallyFantasyPoints(
  sets: SetOutcome[],
  ownerOf: (playerId: string) => string | null | undefined,
  scoring: FantasyScoring = DEFAULT_FANTASY_SCORING,
): FantasyManagerTotal[] {
  const byManager = new Map<string, { points: number; sets: number }>();
  const credit = (line: PlayerSetPoints) => {
    const mgr = ownerOf(line.playerId);
    if (!mgr) return;
    const cur = byManager.get(mgr) ?? { points: 0, sets: 0 };
    cur.points += line.points;
    cur.sets += 1;
    byManager.set(mgr, cur);
  };
  for (const set of sets) {
    const [a, b] = scoreSetForPlayers(set, scoring);
    credit(a);
    credit(b);
  }
  return [...byManager.entries()]
    .map(([managerId, v]) => ({ managerId, points: v.points, sets: v.sets }))
    .sort((x, y) => y.points - x.points || x.managerId.localeCompare(y.managerId));
}
