// Pure ban/pick state machine for a single game in a match — framework- and
// Prisma-agnostic (operates on plain `GameState` JSON). Ported verbatim from the
// league's match-session engine so both apps share one source of truth.
//
// TODO (Phase 0): the current ban policy expresses the league's
// "first bans 1 / second bans N / first bans rest / second picks 1" flow. Team
// Tour wants "ban 5 → pick 3 → choose 1 of 3" — extend `BanPickPolicy` + the
// `phaseFor` step machine to cover that variant (driven by a policy field).

export interface DeckEntry {
  deck: string;
  stake: string;
}

export interface GameState {
  firstId: string; // who bans first this game
  bans: number[]; // indices into THIS game's pool that have been banned
  pickedDeckIdx?: number; // which remaining combo was picked
  winnerId?: string; // confirmed winner (both players' votes agreed)
  // Lives the winner had remaining (attrition, 1..MAX_GAME_LIVES). Required
  // (non-DC) before the game is DONE.
  winnerLives?: number;
  pool: DeckEntry[];
  voteByA?: string;
  voteByB?: string;
  disputed?: boolean;
  rerollVoteByA?: boolean;
  rerollVoteByB?: boolean;
  dcByPlayerId?: string;
  pickedRandomly?: boolean;
  firstBannedRandomly?: boolean;
  otherBannedRandomly?: boolean;
}

export function emptyGameState(firstId: string, pool: DeckEntry[]): GameState {
  return { firstId, bans: [], pool };
}

// Lives a game starts with (attrition). The winner's REMAINING lives are
// captured per game; loser is 0 by definition.
export const MAX_GAME_LIVES = 4;

export const FIRST_PLAYER_BAN_TOTAL = 4;
export const SECOND_PLAYER_BAN_TOTAL = 3;
export const PICKS = 1;

export interface BanPickPolicy {
  firstPlayerBans: number;
  secondPlayerBans: number;
  poolSize: number;
}

export const DEFAULT_POLICY: BanPickPolicy = {
  firstPlayerBans: FIRST_PLAYER_BAN_TOTAL,
  secondPlayerBans: SECOND_PLAYER_BAN_TOTAL,
  poolSize: 9,
};

export function parsePolicy(json: string | null): BanPickPolicy {
  if (!json) return DEFAULT_POLICY;
  try {
    const p = JSON.parse(json) as Partial<BanPickPolicy>;
    if (
      typeof p.firstPlayerBans === "number" &&
      typeof p.secondPlayerBans === "number" &&
      typeof p.poolSize === "number"
    ) {
      return {
        firstPlayerBans: p.firstPlayerBans,
        secondPlayerBans: p.secondPlayerBans,
        poolSize: p.poolSize,
      };
    }
  } catch {
    // fall through
  }
  return DEFAULT_POLICY;
}

export type Phase =
  | { kind: "BAN"; whoseBanId: string; remainingForThem: number; totalDone: number }
  | { kind: "PICK"; pickerId: string }
  | { kind: "PLAYING" }
  | { kind: "AWAIT_LIVES"; winnerId: string }
  | { kind: "DONE" };

export function phaseFor(
  game: GameState,
  playerAId: string,
  playerBId: string,
  policy: BanPickPolicy,
): Phase {
  const otherId = game.firstId === playerAId ? playerBId : playerAId;
  const banCount = game.bans.length;
  const { firstPlayerBans, secondPlayerBans, poolSize } = policy;
  if (game.winnerId) {
    if (!game.dcByPlayerId && game.winnerLives == null) {
      return { kind: "AWAIT_LIVES", winnerId: game.winnerId };
    }
    return { kind: "DONE" };
  }
  if (game.pickedDeckIdx !== undefined) return { kind: "PLAYING" };

  // Step 1: first player bans 1
  if (banCount === 0) {
    return { kind: "BAN", whoseBanId: game.firstId, remainingForThem: 1, totalDone: 0 };
  }
  // Step 2: second player bans secondPlayerBans
  if (banCount >= 1 && banCount < 1 + secondPlayerBans) {
    const done = banCount - 1;
    return {
      kind: "BAN",
      whoseBanId: otherId,
      remainingForThem: secondPlayerBans - done,
      totalDone: banCount,
    };
  }
  // Step 3: first player bans (firstPlayerBans - 1) more
  const remainingFirstBans = firstPlayerBans - 1;
  if (banCount >= 1 + secondPlayerBans && banCount < 1 + secondPlayerBans + remainingFirstBans) {
    const done = banCount - (1 + secondPlayerBans);
    return {
      kind: "BAN",
      whoseBanId: game.firstId,
      remainingForThem: remainingFirstBans - done,
      totalDone: banCount,
    };
  }
  // All bans done — second player picks from what's left
  const totalBans = firstPlayerBans + secondPlayerBans;
  const remaining = poolSize - totalBans;
  if (banCount >= totalBans && remaining >= 1) {
    return { kind: "PICK", pickerId: otherId };
  }
  return { kind: "PLAYING" };
}

export function remainingCombos(pool: DeckEntry[], bans: number[]): { idx: number; combo: DeckEntry }[] {
  const banned = new Set(bans);
  const out: { idx: number; combo: DeckEntry }[] = [];
  pool.forEach((combo, idx) => {
    if (!banned.has(idx)) out.push({ idx, combo });
  });
  return out;
}
