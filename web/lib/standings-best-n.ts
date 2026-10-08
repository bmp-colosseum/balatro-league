// Pure core for the "best N" dropout-adjusted standings preview. Zero
// prisma/react imports (Player/Match are TYPE-only imports, erased at
// compile time -- same convention as web/lib/standings.ts).
//
// THE TO's RULE: in a division of k players with d UNREPLACED dropouts,
// each player's standing counts only their best (k-1-d) results -- "best" by
// points, then win > draw > loss among equal-point results (only relevant
// under a non-default scoring config where a draw and a loss could tie on
// points). Head-to-head in the tiebreak chain applies only when BOTH
// players' COUNTED results include that particular game; otherwise skip to
// the next criterion. A replacement who joined mid-season is capped at the
// number of games they could actually have been scheduled for -- their
// effective N is min(division N, their own scheduledGames).
//
// TWO CANDIDATE VARIANTS for what happens to a game that WAS played against
// the dropout (dropoutGames param, default "count"):
//   - "count": the existing behaviour above -- a result against the
//     dropout is a real, earned result like any other, so it's just one
//     more candidate for best-N selection (it can end up counted or dropped
//     same as any other result). A player who beat the dropout can end up
//     RISING relative to someone who never got the chance to play them.
//   - "void": every result against an unreplaced dropout is removed for
//     EVERYONE first, before best-N selection even runs. Nobody gains or
//     loses anything from having played the dropout -- a survivor who beat
//     them and one who never played them end up with the exact same
//     opportunity set (best N of the SAME pool of remaining opponents).
//     Tiebreak rules (h2h/shootout/wins/draws/name) are unchanged.
//
// This only triggers when d > 0. With zero unreplaced dropouts the division
// bypasses best-N entirely and returns computeStandings' own rows verbatim
// (see the early-return below) -- "Only triggers when a dropout is not
// replaced."
//
// Nothing calls this yet -- it backs an admin-only PREVIEW page
// (web/app/admin/standings-preview) so the TO can see the effect before
// deciding whether to turn it on anywhere. Live standings
// (web/lib/standings-cache.ts) still always calls computeStandings.
//
// TODO(best-n-switch): when the TO decides to enable this, the natural
// switch point is a season-level `scoringMode: "STANDARD" | "BEST_N"` field
// (Prisma schema), read by recomputeDivisionStandings /
// loadDivisionStandings in web/lib/standings-cache.ts (and the bot's mirror,
// src/standings-cache.ts) to pick computeStandings vs computeBestNStandings
// per division. That's a small, separate follow-up -- not part of this leaf.

import type { Match, Player } from "@prisma/client";
import { DEFAULTS, type ScoringConfig } from "@/lib/league-settings";
import {
  type StandingRow,
  type ShootoutInput,
  type Tiebreak,
  type PairingGameLives,
  computeStandings,
  computeNetLives,
  assignRanks,
  headToHead,
  headToHeadLivesDiff,
  shootoutBetween,
  sortStandingsLives,
} from "@/lib/standings";

export type BestNPairing = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB"> & {
  // Optional per-game lives data, only read when tiebreak: "lives" is passed
  // to computeBestNStandings -- see web/lib/standings.ts's PairingGameLives /
  // computeNetLives for the shape and the rule (counted results only, games
  // missing winnerLives contribute 0 + a livesGamesMissing count).
  games?: PairingGameLives[];
};

// "count" (default) keeps today's behaviour: a result against an unreplaced
// dropout is a normal candidate for best-N selection. "void" erases every
// such result for everyone before selection runs -- see the header above.
export type DropoutGamesMode = "count" | "void";

export interface BestNMemberInput {
  player: Player;
  status: "ACTIVE" | "DROPPED";
  // True for an ACTIVE member who slotted into the division mid-season to
  // take over a DIFFERENT dropout's vacated slot (see
  // web/lib/replace-division-player.ts, or an admin "add player" after a
  // soft drop). Ignored for DROPPED rows. Determining this is a shell-side
  // judgment call (based on join/drop timestamps) -- the core just trusts it.
  isReplacement: boolean;
  // This member's total scheduled LEAGUE_BO2 games in the division (any
  // status -- the full set of matches ever assigned to them). Only read when
  // isReplacement is true, to cap their effective N below the division's.
  scheduledGames: number;
}

export interface BestNDroppedResult {
  opponentId: string;
  opponent: string;
  points: number;
}

export interface BestNStandingRow extends StandingRow {
  // How many of this player's results counted toward their standing, and
  // the cap ("of") that selection was made against -- e.g. counted: 5, of: 5
  // reads as "counts best 5 of 5" for a replacement capped below the
  // division's N, or "5 of 6" for a normal member in a 7-player/1-dropout
  // division (division.n = 5, their actual games played could be 5 or 6).
  counted: number;
  of: number;
  // This player's results that did NOT make the counted cut (their worst
  // played - counted results), for the UI to show what got dropped.
  droppedResults: BestNDroppedResult[];
}

export interface BestNDivisionSummary {
  // Results counted per player before any individual replacement cap:
  // k - 1 - dropouts.
  n: number;
  // Division size INCLUDING unreplaced dropouts (the original full roster).
  k: number;
  // Matches each player is scheduled to play: the division's opponents-per-player setting,
  // else the largest schedule any original member has, else k-1 for a full round robin.
  scheduled: number;
  // Unreplaced dropouts (DROPPED members minus replacements), floored at 0.
  // 0 means best-N is NOT triggered for this division.
  dropouts: number;
}

export interface BestNStandingsResult {
  rows: BestNStandingRow[];
  division: BestNDivisionSummary;
}

interface PlayerResult {
  opponentId: string;
  points: number;
  // 2 = win, 1 = draw, 0 = loss -- breaks a points tie when picking which
  // results count (only matters under a non-default scoring config where a
  // draw and a loss could score the same).
  rank: 2 | 1 | 0;
  gamesWon: number;
  gamesLost: number;
  // Carried through from the originating BestNPairing so netLives can be
  // computed from exactly the results that ended up COUNTED (see the
  // tiebreak: "lives" branch below) -- undefined when the pairing had no
  // games data.
  games?: PairingGameLives[];
}

// Best-first: higher points first, then win > draw > loss, then opponent id
// for a fully deterministic order. Among a genuine tie (same points AND
// rank), which exact result gets dropped is immaterial to the counted sum --
// any choice yields the same maximum (see the "maximum-points subset"
// property this guarantees).
function sortResultsBestFirst(results: PlayerResult[]): PlayerResult[] {
  return results
    .slice()
    .sort((x, y) => y.points - x.points || y.rank - x.rank || x.opponentId.localeCompare(y.opponentId));
}

export function computeBestNStandings(
  members: BestNMemberInput[],
  pairings: BestNPairing[],
  shootouts: ShootoutInput[] = [],
  scoring: ScoringConfig = DEFAULTS.scoring,
  dropoutGames: DropoutGamesMode = "count",
  scheduledPerPlayer: number | null = null,
  tiebreak: Tiebreak = "chain",
): BestNStandingsResult {
  const active = members.filter((m) => m.status === "ACTIVE");
  const droppedCount = members.filter((m) => m.status === "DROPPED").length;
  const replacementCount = active.filter((m) => m.isReplacement).length;
  const k = active.length + droppedCount;
  const dropouts = Math.max(0, droppedCount - replacementCount);
  // The league schedules a fixed number of MATCHES per player, not a full round robin: a
  // division of 6 may play 4 each. N is that schedule size minus the unreplaced dropouts,
  // so "best 3 of 4 matches" in that case; a full round robin degrades to k-1-d as before.
  const largestOriginalSchedule = Math.max(0, ...active.filter((m) => !m.isReplacement).map((m) => m.scheduledGames));
  const scheduled = scheduledPerPlayer ?? (largestOriginalSchedule > 0 ? largestOriginalSchedule : Math.max(0, k - 1));
  const n = Math.max(0, scheduled - dropouts);

  if (dropouts === 0) {
    // No unreplaced dropout anywhere in the division -- best-N doesn't
    // trigger (dropoutGames is moot: there's nothing to void or count
    // differently). Reuse computeStandings verbatim rather than
    // reimplementing the "everyone's N covers everything they played"
    // degenerate case.
    const rows: BestNStandingRow[] = computeStandings(
      active.map((m) => m.player),
      pairings,
      shootouts,
      scoring,
      tiebreak,
    ).map((row) => ({ ...row, counted: row.played, of: row.played, droppedResults: [] }));
    return { rows, division: { n, k, scheduled, dropouts } };
  }

  // "void": strip every result touching a DROPPED member before anything
  // else runs, so the dropout never existed as far as selection/points are
  // concerned. (A cleanly pre-play replaceDivisionPlayer swap never leaves a
  // DROPPED member with a confirmed result in the first place -- the only
  // way a DROPPED member here has one is the mid-season soft-drop path, the
  // exact "unreplaced dropout" case this whole feature is about.)
  const droppedIds = new Set(members.filter((m) => m.status === "DROPPED").map((m) => m.player.id));
  const effectivePairings = dropoutGames === "void"
    ? pairings.filter((pr) => !droppedIds.has(pr.playerAId) && !droppedIds.has(pr.playerBId))
    : pairings;
  const effectiveShootouts = dropoutGames === "void"
    ? shootouts.filter((s) => !droppedIds.has(s.playerAId) && !droppedIds.has(s.playerBId))
    : shootouts;

  // Build a full (ACTIVE + DROPPED) id -> Player lookup so a "count"-mode
  // confirmed result against an already-dropped opponent still resolves and
  // counts for whoever played it -- it was a real, earned result, even
  // though the dropped player gets no standing row of their own.
  const playerById = new Map(members.map((m) => [m.player.id, m.player]));

  const resultsByPlayerId = new Map<string, PlayerResult[]>();
  for (const m of active) resultsByPlayerId.set(m.player.id, []);

  for (const pr of effectivePairings) {
    const aIsActive = resultsByPlayerId.has(pr.playerAId);
    const bIsActive = resultsByPlayerId.has(pr.playerBId);
    if (!aIsActive && !bIsActive) continue;
    const aPlayer = playerById.get(pr.playerAId);
    const bPlayer = playerById.get(pr.playerBId);
    if (!aPlayer || !bPlayer) continue; // ghost pairing -- unknown opponent

    let aPoints = 0, bPoints = 0;
    let aRank: 2 | 1 | 0 = 0, bRank: 2 | 1 | 0 = 0;
    if (pr.gamesWonA === 2 && pr.gamesWonB === 0) {
      aPoints = scoring.pointsFor20Win; bPoints = scoring.pointsForLoss;
      aRank = 2; bRank = 0;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      bPoints = scoring.pointsFor20Win; aPoints = scoring.pointsForLoss;
      bRank = 2; aRank = 0;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      aPoints = scoring.pointsFor11Draw; bPoints = scoring.pointsFor11Draw;
      aRank = 1; bRank = 1;
    } else {
      continue; // not a valid BO2 result -- doesn't count as a "result"
    }

    if (aIsActive) {
      resultsByPlayerId.get(pr.playerAId)!.push({
        opponentId: pr.playerBId, points: aPoints, rank: aRank,
        gamesWon: pr.gamesWonA, gamesLost: pr.gamesWonB,
        games: pr.games,
      });
    }
    if (bIsActive) {
      resultsByPlayerId.get(pr.playerBId)!.push({
        opponentId: pr.playerAId, points: bPoints, rank: bRank,
        gamesWon: pr.gamesWonB, gamesLost: pr.gamesWonA,
        games: pr.games,
      });
    }
  }

  const countedOpponentsByPlayerId = new Map<string, Set<string>>();
  const rows: BestNStandingRow[] = [];

  for (const m of active) {
    const results = sortResultsBestFirst(resultsByPlayerId.get(m.player.id) ?? []);
    const of = m.isReplacement ? Math.min(n, m.scheduledGames) : n;
    const counted = Math.min(of, results.length);
    const countedResults = results.slice(0, counted);
    const droppedResults = results.slice(counted);

    countedOpponentsByPlayerId.set(m.player.id, new Set(countedResults.map((r) => r.opponentId)));

    let points = 0, wins = 0, draws = 0, losses = 0, gamesWon = 0, gamesLost = 0;
    for (const r of countedResults) {
      points += r.points; gamesWon += r.gamesWon; gamesLost += r.gamesLost;
      if (r.rank === 2) wins++;
      else if (r.rank === 1) draws++;
      else losses++;
    }

    // Net lives only from the COUNTED results, per the TO's rule -- a result
    // dropped by best-N selection doesn't contribute lives either. Each
    // countedResult becomes a synthetic one-sided pairing (playerAId: me) so
    // computeNetLives (which only cares whether playerId appears, not which
    // side) can read its games data directly.
    let netLives: number | undefined;
    let livesGamesMissing: number | undefined;
    if (tiebreak === "lives") {
      const nl = computeNetLives(
        m.player.id,
        countedResults.map((r) => ({ playerAId: m.player.id, playerBId: r.opponentId, games: r.games })),
      );
      netLives = nl.netLives;
      livesGamesMissing = nl.livesGamesMissing;
    }

    rows.push({
      player: m.player,
      points, wins, draws, losses, gamesWon, gamesLost,
      played: results.length,
      counted, of,
      netLives,
      livesGamesMissing,
      droppedResults: droppedResults.map((r) => ({
        opponentId: r.opponentId,
        opponent: playerById.get(r.opponentId)?.displayName ?? r.opponentId,
        points: r.points,
      })),
    });
  }

  // Both players' COUNTED sets must include their mutual game for h2h to
  // apply -- a result dropped by either side's best-N selection doesn't
  // break the tie, per the TO's rule.
  // Both players' COUNTED sets must include their mutual game for h2h (chain)
  // or the h2h-lives differential (lives) to apply -- a result dropped by
  // either side's best-N selection doesn't break the tie, per the TO's rule.
  const bothCounted = (xId: string, yId: string): boolean =>
    (countedOpponentsByPlayerId.get(xId)?.has(yId) ?? false) &&
    (countedOpponentsByPlayerId.get(yId)?.has(xId) ?? false);

  let sorted: BestNStandingRow[];
  if (tiebreak === "lives") {
    sorted = sortStandingsLives(
      rows,
      (xId, yId) => shootoutBetween(xId, yId, effectiveShootouts),
      (xId, yId) => (bothCounted(xId, yId) ? headToHeadLivesDiff(xId, yId, effectivePairings) : null),
    );
  } else {
    sorted = rows.slice().sort((x, y) => {
      if (y.points !== x.points) return y.points - x.points;
      if (bothCounted(x.player.id, y.player.id)) {
        const h2h = headToHead(x.player.id, y.player.id, effectivePairings);
        if (h2h !== 0) return h2h;
      }
      const shoot = shootoutBetween(x.player.id, y.player.id, effectiveShootouts);
      if (shoot !== 0) return shoot;
      if (y.wins !== x.wins) return y.wins - x.wins;
      if (y.draws !== x.draws) return y.draws - x.draws;
      return x.player.displayName.localeCompare(y.player.displayName);
    });

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const h2h = bothCounted(prev.player.id, cur.player.id)
        ? headToHead(prev.player.id, cur.player.id, effectivePairings)
        : 0;
      if (
        prev.points === cur.points &&
        h2h === 0 &&
        shootoutBetween(prev.player.id, cur.player.id, effectiveShootouts) === 0 &&
        prev.wins === cur.wins &&
        prev.draws === cur.draws
      ) {
        cur.tiedWithPrev = true;
      }
    }
  }

  assignRanks(sorted);
  return { rows: sorted, division: { n, k, scheduled, dropouts } };
}

export interface RawMemberForBestN {
  player: Player;
  status: "ACTIVE" | "DROPPED";
  joinedAt: Date;
  droppedAt: Date | null;
}

// Builds BestNMemberInput[] from raw DivisionMember-shaped rows + each
// member's total scheduled LEAGUE_BO2 game count. Centralizes the
// "isReplacement" heuristic (joined after another member's earliest real
// drop) so every caller -- the admin preview, and both the web's and the
// bot's live standings cache (src/standings-best-n.ts mirrors this function
// verbatim) -- agrees on who's a replacement. Pure: no DB, just data in.
export function buildBestNMembers(
  members: RawMemberForBestN[],
  scheduledGamesByPlayerId: ReadonlyMap<string, number>,
): BestNMemberInput[] {
  const earliestDropAt = members.reduce<Date | null>((min, m) => {
    if (m.status !== "DROPPED" || !m.droppedAt) return min;
    return !min || m.droppedAt < min ? m.droppedAt : min;
  }, null);
  return members.map((m) => ({
    player: m.player,
    status: m.status,
    isReplacement: m.status === "ACTIVE" && earliestDropAt !== null && m.joinedAt > earliestDropAt,
    scheduledGames: scheduledGamesByPlayerId.get(m.player.id) ?? 0,
  }));
}
