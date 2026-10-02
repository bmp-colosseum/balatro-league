// Pure decision core for "fun player traits" (see web/lib/loaders/player-traits.ts
// for the DB-fetch + presentation shell that wraps this). Zero imports — this
// file runs under the root vitest project (web/lib/**/*.test.ts) without any
// Prisma/env entanglement; see vitest.config.ts's `include`.
//
// Given a player's confirmed, non-DC games (deck/stake pool rows included),
// decides which trait KEYS they've earned and the per-player stat-line detail
// for each. Presentation (label/emoji/description/admin override) is layered
// on top by the shell at render time — this core only makes the earn/no-earn
// decision + the numbers behind it, which is exactly what gets cached.

export interface TraitPoolRow {
  deck: string;
  stake: string;
  picked: boolean;
  bannedById: string | null;
}

export interface TraitGameRow {
  firstPlayerId: string;
  winnerId: string | null;
  pickedRandomly: boolean;
  pool: TraitPoolRow[];
}

export interface EarnedTrait {
  key: string;
  detail: string;
}

// 10-game floor — a trait is earned over a few seasons, not in one.
export const TRAIT_GAMES_FLOOR = 10;

type Counts = Record<string, number>;
function bump(c: Counts, k: string): void {
  c[k] = (c[k] ?? 0) + 1;
}

// Deterministic "top stake": highest `metric` count, ties broken by the
// `tiebreak` count, then by stake name (alphabetical). Shared by the profile
// and the /admin/traits "who has what" view so a player's traits are
// IDENTICAL on both surfaces.
export function topStakeDeterministic(
  metric: Record<string, number>,
  tiebreak: Record<string, number>,
): string | null {
  let best: { name: string; m: number; tb: number } | null = null;
  for (const name of Object.keys(metric).sort()) {
    const m = metric[name] ?? 0;
    if (m <= 0) continue;
    const tb = tiebreak[name] ?? 0;
    if (!best || m > best.m || (m === best.m && tb > best.tb)) best = { name, m, tb };
  }
  return best?.name ?? null;
}

// The decision core: which traits does this playerId earn from these games?
// Pure — no DB, no clock, no randomness. Returns ONLY key + detail (the
// gating decision + its stat line); presentation lives in the shell.
export function computeEarnedTraits(playerId: string, playerGames: TraitGameRow[]): EarnedTrait[] {
  const playedStakes: Counts = {};
  const wonStakes: Counts = {};
  let totalPicks = 0;
  let games = 0;
  let randomPicks = 0;
  let randomPickWins = 0;
  let ghostAvailable = 0;
  let ghostBanned = 0;

  for (const g of playerGames) {
    if (g.pool.length === 0) continue;
    games++;
    const isFirst = g.firstPlayerId === playerId;

    const ghostRow = g.pool.find((d) => d.deck === "Ghost");
    if (ghostRow) {
      ghostAvailable++;
      if (ghostRow.bannedById === playerId) ghostBanned++;
    }

    const picked = g.pool.find((d) => d.picked);
    if (picked) {
      bump(playedStakes, picked.stake);
      if (g.winnerId === playerId) bump(wonStakes, picked.stake);
      if (!isFirst) {
        totalPicks++;
        if (g.pickedRandomly) {
          randomPicks++;
          if (g.winnerId === playerId) randomPickWins++;
        }
      }
    }
  }

  if (games < TRAIT_GAMES_FLOOR) return [];

  const earned: EarnedTrait[] = [];
  const topPlayedStake = topStakeDeterministic(playedStakes, wonStakes);
  const topWonStake = topStakeDeterministic(wonStakes, playedStakes);

  if (topPlayedStake === "White" && topWonStake === "White") {
    earned.push({
      key: "white-warrior",
      detail: `${playedStakes["White"] ?? 0} games on White · ${wonStakes["White"] ?? 0} wins on it`,
    });
  }
  if (topPlayedStake === "Gold" && topWonStake === "Gold") {
    earned.push({
      key: "dr-spectred",
      detail: `${playedStakes["Gold"] ?? 0} games on Gold · ${wonStakes["Gold"] ?? 0} wins on it`,
    });
  }
  if (ghostAvailable > 0 && ghostBanned / ghostAvailable >= 0.6) {
    earned.push({
      key: "ghostbuster",
      detail: `banned Ghost in ${Math.round((ghostBanned / ghostAvailable) * 100)}% of games it appeared`,
    });
  }
  if (randomPicks > 0 && randomPicks / totalPicks >= 0.5 && randomPickWins / randomPicks >= 0.5) {
    earned.push({
      key: "super-balatro-genius",
      detail: `won ${randomPickWins} of ${randomPicks} random picks`,
    });
  }
  return earned;
}
