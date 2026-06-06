// Fun "player traits" derived from a player's ban/pick behaviour across
// their confirmed matches. Purely cosmetic flavour — not used for anything
// scoring-related.
//
// Attribution: per game the FIRST player bans index [0] then [4,5,6], the
// OTHER player bans [1,2,3] and makes the final PICK (pickedDeckIdx). So a
// player's bans/picks depend on whether they were `firstId` that game.

import { prisma } from "@/lib/prisma";

interface GameStateMin {
  firstId?: string;
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  dcByPlayerId?: string;
  bans?: number[];
}

export interface PlayerTrait {
  key: string;
  label: string;
  emoji: string;
  description: string;
  detail: string;
}

// Relative difficulty rank among the pool's stakes (White easiest → Gold
// hardest). Canonical order is White, Red, Green, Black, Blue, Purple,
// Orange, Gold; the league pool uses 5 of them — rank them 0..4.
const STAKE_RANK: Record<string, number> = { White: 0, Green: 1, Black: 2, Purple: 3, Gold: 4 };

type Counts = Record<string, number>;
function bump(c: Counts, k: string): void {
  c[k] = (c[k] ?? 0) + 1;
}
function topEntry(c: Counts): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of Object.entries(c)) {
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}
function avgRank(c: Counts): number | null {
  let sum = 0;
  let n = 0;
  for (const [stake, count] of Object.entries(c)) {
    const r = STAKE_RANK[stake];
    if (r === undefined) continue;
    sum += r * count;
    n += count;
  }
  return n > 0 ? sum / n : null;
}

export async function loadPlayerTraits(playerId: string): Promise<PlayerTrait[]> {
  const pairings = await prisma.pairing.findMany({
    where: { status: "CONFIRMED", OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    select: { id: true },
  });
  if (pairings.length === 0) return [];
  const sessions = await prisma.matchSession.findMany({
    where: { pairingId: { in: pairings.map((p) => p.id) } },
    select: { game1: true, game2: true, game3: true },
  });

  const bannedStakes: Counts = {};
  const pickedStakes: Counts = {};
  const bannedDecks: Counts = {};
  const pickedDecks: Counts = {};
  let totalBans = 0;
  let totalPicks = 0;
  let games = 0;

  for (const s of sessions) {
    for (const json of [s.game1, s.game2, s.game3]) {
      if (!json) continue;
      let g: GameStateMin;
      try {
        g = JSON.parse(json) as GameStateMin;
      } catch {
        continue;
      }
      if (!g.pool || g.pool.length === 0 || g.dcByPlayerId || !g.firstId) continue;
      games++;
      const isFirst = g.firstId === playerId;
      const bans = g.bans ?? [];
      // First player: [0] + [4..]; other player: [1..3].
      const myBanIdxs = isFirst ? [bans[0], ...bans.slice(4)] : bans.slice(1, 4);
      for (const idx of myBanIdxs) {
        if (idx === undefined) continue;
        const combo = g.pool[idx];
        if (!combo) continue;
        bump(bannedStakes, combo.stake);
        bump(bannedDecks, combo.deck);
        totalBans++;
      }
      // Only the OTHER (non-first) player makes the final pick.
      if (!isFirst && g.pickedDeckIdx !== undefined) {
        const combo = g.pool[g.pickedDeckIdx];
        if (combo) {
          bump(pickedStakes, combo.stake);
          bump(pickedDecks, combo.deck);
          totalPicks++;
        }
      }
    }
  }

  if (games < 4) return []; // not enough signal yet

  const traits: PlayerTrait[] = [];
  const pickedAvg = avgRank(pickedStakes);
  const bannedAvg = avgRank(bannedStakes);

  // Picks easy stakes + bans the brutal ones → plays it safe.
  if (pickedAvg !== null && bannedAvg !== null && totalPicks >= 4 && pickedAvg <= 1.2 && bannedAvg >= 2.4) {
    traits.push({
      key: "white-warrior",
      label: "White Stake Warrior",
      emoji: "🤍",
      description: "Picks the gentle stakes and bans the brutal ones — plays it safe.",
      detail: `avg picked stake ${pickedAvg.toFixed(1)}/4, banned ${bannedAvg.toFixed(1)}/4`,
    });
  }
  // Picks the nastiest stakes on purpose.
  if (pickedAvg !== null && totalPicks >= 4 && pickedAvg >= 2.8) {
    traits.push({
      key: "gold-gladiator",
      label: "Gold Stake Gladiator",
      emoji: "🥇",
      description: "Picks the nastiest stakes on purpose. No fear.",
      detail: `avg picked stake ${pickedAvg.toFixed(1)}/4`,
    });
  }
  // Keeps reaching for the same deck.
  const topPick = topEntry(pickedDecks);
  if (topPick && totalPicks >= 5 && topPick.count / totalPicks >= 0.4) {
    traits.push({
      key: "deck-loyalist",
      label: "Deck Loyalist",
      emoji: "🃏",
      description: "Keeps reaching for the same deck.",
      detail: `${topPick.name} on ${Math.round((topPick.count / totalPicks) * 100)}% of picks`,
    });
  }
  // Never picks the same thing twice.
  const distinctPicked = Object.keys(pickedDecks).length;
  if (totalPicks >= 6 && distinctPicked >= Math.min(6, totalPicks)) {
    traits.push({
      key: "wildcard",
      label: "Wildcard",
      emoji: "🎲",
      description: "Never picks the same thing twice.",
      detail: `${distinctPicked} different decks picked`,
    });
  }
  // Bans one deck on sight.
  const topBan = topEntry(bannedDecks);
  if (topBan && totalBans >= 6 && topBan.count / totalBans >= 0.25) {
    traits.push({
      key: "nemesis",
      label: `${topBan.name} Hater`,
      emoji: "🔨",
      description: "Bans this deck on sight.",
      detail: `banned ${topBan.name} ${topBan.count}×`,
    });
  }

  return traits;
}
