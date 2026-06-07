// Loader for /admin/traits + the public /traits guide — the trait catalog
// (registry merged with admin overrides) plus the "who currently has each
// trait" lists.
//
// Holders are computed with a fixed handful of SQL GROUP BY queries (NOT one
// query per player — that's O(players) round-trips and falls over on a large
// league). Each query explodes a confirmed game into its two participants and
// aggregates the exact signals the trait gating needs. The membership logic
// below MUST stay in sync with loadPlayerTraits() in player-traits.ts, which
// computes the same traits for a single player (the profile path).

import { prisma } from "@/lib/prisma";
import { TRAIT_REGISTRY, loadTraitOverrides } from "./player-traits";

export interface TraitHolder {
  id: string;
  name: string;
}

export interface TraitAdminRow {
  key: string;
  // Effective (override-or-default) presentation.
  label: string;
  emoji: string;
  description: string;
  iconDataUrl: string | null;
  // Plain-language gating rule (how the trait is earned). Read-only.
  criteria: string;
  // The code defaults, so the editor can show "default: …" hints.
  defaultLabel: string;
  defaultEmoji: string;
  defaultDescription: string;
  // True if any override row exists for this key.
  overridden: boolean;
  // Players who currently earn this trait, by display name.
  holders: TraitHolder[];
}

const GAMES_FLOOR = 10; // matches loadPlayerTraits — traits need 10+ games

// Per (player, stake): games played on that stake + games won on it. One row
// per (game, participant), so a player's total games = SUM(played).
interface StakeRow {
  player_id: string;
  stake: string;
  played: number;
  won: number;
}
// Per player picking as the non-first player: pick count + random-pick count +
// random-pick wins.
interface PickRow {
  player_id: string;
  total_picks: number;
  random_picks: number;
  random_pick_wins: number;
}
// Per player: games where Ghost was in the pool + games they banned it.
interface GhostRow {
  player_id: string;
  ghost_available: number;
  ghost_banned: number;
}

// Compute the holder set for every trait in a fixed number of queries.
async function computeTraitHolders(): Promise<Map<string, TraitHolder[]>> {
  // Stake play/win counts, exploded to each game's two participants. Only
  // confirmed, non-DC games with a pool count (matches loadPlayerTraits).
  const stakeRows = await prisma.$queryRaw<StakeRow[]>`
    SELECT player_id, stake, COUNT(*)::int AS played,
           SUM(CASE WHEN won THEN 1 ELSE 0 END)::int AS won
    FROM (
      SELECT m."playerAId" AS player_id, g.stake AS stake, (g."winnerId" = m."playerAId") AS won
      FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
      WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
        AND EXISTS (SELECT 1 FROM "GameDeck" gd WHERE gd."gameId" = g.id)
      UNION ALL
      SELECT m."playerBId", g.stake, (g."winnerId" = m."playerBId")
      FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
      WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
        AND EXISTS (SELECT 1 FROM "GameDeck" gd WHERE gd."gameId" = g.id)
    ) t
    GROUP BY player_id, stake
  `;

  // Pick behaviour — the picker is the NON-first participant of each game.
  const pickRows = await prisma.$queryRaw<PickRow[]>`
    SELECT player_id,
           COUNT(*)::int AS total_picks,
           SUM(CASE WHEN picked_randomly THEN 1 ELSE 0 END)::int AS random_picks,
           SUM(CASE WHEN picked_randomly AND won THEN 1 ELSE 0 END)::int AS random_pick_wins
    FROM (
      SELECT
        (CASE WHEN g."firstPlayerId" = m."playerAId" THEN m."playerBId" ELSE m."playerAId" END) AS player_id,
        g."pickedRandomly" AS picked_randomly,
        (g."winnerId" = (CASE WHEN g."firstPlayerId" = m."playerAId" THEN m."playerBId" ELSE m."playerAId" END)) AS won
      FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
      WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
        AND EXISTS (SELECT 1 FROM "GameDeck" gd WHERE gd."gameId" = g.id)
    ) t
    GROUP BY player_id
  `;

  // Ghostbuster — per (game, participant) whether Ghost appeared and whether
  // that player banned it, then summed per player.
  const ghostRows = await prisma.$queryRaw<GhostRow[]>`
    SELECT player_id,
           SUM(CASE WHEN ghost_appeared THEN 1 ELSE 0 END)::int AS ghost_available,
           SUM(CASE WHEN ghost_banned THEN 1 ELSE 0 END)::int AS ghost_banned
    FROM (
      SELECT b.player_id, b.game_id,
             BOOL_OR(gd.deck = 'Ghost') AS ghost_appeared,
             BOOL_OR(gd.deck = 'Ghost' AND gd."bannedById" = b.player_id) AS ghost_banned
      FROM (
        SELECT g.id AS game_id, m."playerAId" AS player_id
        FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
        WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
        UNION ALL
        SELECT g.id, m."playerBId"
        FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
        WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
      ) b
      JOIN "GameDeck" gd ON gd."gameId" = b.game_id
      GROUP BY b.player_id, b.game_id
    ) per_game
    GROUP BY player_id
  `;

  // Fold per-player: total games + top played stake + top *won* stake (only
  // among stakes actually won, mirroring loadPlayerTraits' wonStakes).
  interface Agg {
    games: number;
    topPlayedStake: string | null;
    topPlayedN: number;
    topWonStake: string | null;
    topWonN: number;
  }
  const agg = new Map<string, Agg>();
  for (const r of stakeRows) {
    const e =
      agg.get(r.player_id) ??
      { games: 0, topPlayedStake: null, topPlayedN: -1, topWonStake: null, topWonN: -1 };
    e.games += r.played;
    if (r.played > e.topPlayedN) {
      e.topPlayedN = r.played;
      e.topPlayedStake = r.stake;
    }
    if (r.won > 0 && r.won > e.topWonN) {
      e.topWonN = r.won;
      e.topWonStake = r.stake;
    }
    agg.set(r.player_id, e);
  }
  const gamesOf = (pid: string) => agg.get(pid)?.games ?? 0;

  const holderIds: Record<string, Set<string>> = {
    "white-warrior": new Set(),
    "dr-spectred": new Set(),
    "ghostbuster": new Set(),
    "super-balatro-genius": new Set(),
  };

  for (const [pid, e] of agg) {
    if (e.games < GAMES_FLOOR) continue;
    if (e.topPlayedStake === "White" && e.topWonStake === "White") holderIds["white-warrior"].add(pid);
    if (e.topPlayedStake === "Gold" && e.topWonStake === "Gold") holderIds["dr-spectred"].add(pid);
  }
  for (const r of ghostRows) {
    if (gamesOf(r.player_id) < GAMES_FLOOR) continue;
    if (r.ghost_available > 0 && r.ghost_banned / r.ghost_available >= 0.6) {
      holderIds["ghostbuster"].add(r.player_id);
    }
  }
  for (const r of pickRows) {
    if (gamesOf(r.player_id) < GAMES_FLOOR) continue;
    if (
      r.random_picks > 0 &&
      r.random_picks / r.total_picks >= 0.5 &&
      r.random_pick_wins / r.random_picks >= 0.5
    ) {
      holderIds["super-balatro-genius"].add(r.player_id);
    }
  }

  // Resolve display names for just the holders (one query).
  const allIds = new Set<string>();
  for (const set of Object.values(holderIds)) for (const id of set) allIds.add(id);
  const names = await prisma.player.findMany({
    where: { id: { in: [...allIds] } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(names.map((n) => [n.id, n.displayName]));

  const result = new Map<string, TraitHolder[]>();
  for (const [key, ids] of Object.entries(holderIds)) {
    const arr = [...ids]
      .map((id) => ({ id, name: nameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    result.set(key, arr);
  }
  return result;
}

export async function loadTraitsAdmin(): Promise<TraitAdminRow[]> {
  const overrides = await loadTraitOverrides();

  // Holders are a best-effort overlay — never let them break the page; the
  // catalog (labels/criteria/icons) always renders.
  let holdersByKey = new Map<string, TraitHolder[]>();
  try {
    holdersByKey = await computeTraitHolders();
  } catch {
    holdersByKey = new Map();
  }

  return TRAIT_REGISTRY.map((def) => {
    const ov = overrides.get(def.key);
    return {
      key: def.key,
      label: ov?.label ?? def.label,
      emoji: ov?.emoji ?? def.emoji,
      description: ov?.description ?? def.description,
      iconDataUrl: ov?.iconDataUrl ?? null,
      criteria: def.criteria,
      defaultLabel: def.label,
      defaultEmoji: def.emoji,
      defaultDescription: def.description,
      overridden: !!ov,
      holders: holdersByKey.get(def.key) ?? [],
    };
  });
}
