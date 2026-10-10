// Pure core: given every player's division-membership history across every
// season (one row per season they were ever placed in a division for --
// ACTIVE and DROPPED members both count as "played", since status only
// tracks whether they're still in it), pick the players whose FIRST-ever
// season is the given target season number. Used to find this season's
// first-timers for the onboarding-guide admin tool.

export interface SeasonMembership {
  playerId: string;
  seasonNumber: number;
}

// A player can appear more than once in `memberships` (once per season they
// played); only their EARLIEST season number decides whether they're new.
// Order-independent and dedupes repeated rows for the same (playerId,
// seasonNumber) pair. Returned ids are sorted for a deterministic result.
export function findNewcomerPlayerIds(
  memberships: SeasonMembership[],
  targetSeasonNumber: number,
): string[] {
  const firstSeasonByPlayer = new Map<string, number>();
  for (const m of memberships) {
    const existing = firstSeasonByPlayer.get(m.playerId);
    if (existing === undefined || m.seasonNumber < existing) {
      firstSeasonByPlayer.set(m.playerId, m.seasonNumber);
    }
  }
  const result: string[] = [];
  for (const [playerId, firstSeason] of firstSeasonByPlayer) {
    if (firstSeason === targetSeasonNumber) result.push(playerId);
  }
  return result.sort();
}
