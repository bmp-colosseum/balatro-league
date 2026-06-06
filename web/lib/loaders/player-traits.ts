// Fun "player traits" derived from a player's ban/pick behaviour across
// their confirmed matches. Purely cosmetic flavour — not used for anything
// scoring-related. Local Thunk would approve of the puns.
//
// Attribution: per game the FIRST player bans index [0] then [4,5,6], the
// OTHER player bans [1,2,3] and makes the final PICK (pickedDeckIdx). So a
// player's bans/picks depend on whether they were `firstId` that game. The
// player's FIRST ban is bans[0] (if first) or bans[1] (if other).

import { prisma } from "@/lib/prisma";

interface GameStateMin {
  firstId?: string;
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  dcByPlayerId?: string;
  bans?: number[];
  pickedRandomly?: boolean;
  firstBannedRandomly?: boolean;
  otherBannedRandomly?: boolean;
}

export interface PlayerTrait {
  key: string;
  label: string;
  emoji: string;
  description: string;
  detail: string;
}

// Relative difficulty rank among the pool's stakes (White easiest → Gold
// hardest); the league pool uses 5 of the 8 canonical stakes.
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
  const pickedDecks: Counts = {};
  const firstBannedDecks: Counts = {};
  const firstBannedStakes: Counts = {};
  let totalBans = 0;
  let totalPicks = 0;
  let games = 0;
  let randomGames = 0;

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
      const myBanIdxs = isFirst ? [bans[0], ...bans.slice(4)] : bans.slice(1, 4);
      for (const idx of myBanIdxs) {
        if (idx === undefined) continue;
        const combo = g.pool[idx];
        if (!combo) continue;
        bump(bannedStakes, combo.stake);
        totalBans++;
      }
      // The player's FIRST ban of the game (bans[0] if first, bans[1] if other).
      const myFirstBanIdx = isFirst ? bans[0] : bans[1];
      if (myFirstBanIdx !== undefined) {
        const combo = g.pool[myFirstBanIdx];
        if (combo) {
          bump(firstBannedDecks, combo.deck);
          bump(firstBannedStakes, combo.stake);
        }
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
      // Did this player use a 🎲 random button this game?
      const usedRandom = isFirst
        ? !!g.firstBannedRandomly
        : !!g.otherBannedRandomly || !!g.pickedRandomly;
      if (usedRandom) randomGames++;
    }
  }

  if (games < 4) return []; // not enough signal yet

  const traits: PlayerTrait[] = [];
  const pickedAvg = avgRank(pickedStakes);
  const bannedAvg = avgRank(bannedStakes);

  // 🤍 White Stake Warrior — picks the gentle stakes, bans the brutal ones.
  if (pickedAvg !== null && bannedAvg !== null && totalPicks >= 4 && pickedAvg <= 1.2 && bannedAvg >= 2.4) {
    traits.push({
      key: "white-warrior",
      label: "White Stake Warrior",
      emoji: "🤍",
      description: "Picks the gentle stakes and bans the brutal ones — plays it safe.",
      detail: `avg picked stake ${pickedAvg.toFixed(1)}/4`,
    });
  }
  // 🎩 Dr. Spectre — the resident high-stakes menace.
  if (pickedAvg !== null && totalPicks >= 4 && pickedAvg >= 2.8) {
    traits.push({
      key: "dr-spectre",
      label: "Dr. Spectre",
      emoji: "🎩",
      description: "Picks the nastiest stakes on purpose. A true high-stakes player.",
      detail: `avg picked stake ${pickedAvg.toFixed(1)}/4`,
    });
  }
  // 🃏 Deck Loyalist — keeps reaching for the same deck. Shows the favourite.
  const topPick = topEntry(pickedDecks);
  if (topPick && totalPicks >= 5 && topPick.count / totalPicks >= 0.4) {
    traits.push({
      key: "deck-loyalist",
      label: "Deck Loyalist",
      emoji: "🃏",
      description: `Always reaching for the same deck.`,
      detail: `Favourite: ${topPick.name} (${Math.round((topPick.count / totalPicks) * 100)}% of picks)`,
    });
  }
  // 🔨 {X} Hater — consistently FIRST-bans a particular deck or stake.
  const topFirstDeck = topEntry(firstBannedDecks);
  const topFirstStake = topEntry(firstBannedStakes);
  const deckHateRate = topFirstDeck ? topFirstDeck.count / games : 0;
  const stakeHateRate = topFirstStake ? topFirstStake.count / games : 0;
  if (games >= 5 && (deckHateRate >= 0.45 || stakeHateRate >= 0.45)) {
    const useDeck = deckHateRate >= stakeHateRate;
    const target = useDeck ? topFirstDeck! : topFirstStake!;
    const rate = useDeck ? deckHateRate : stakeHateRate;
    traits.push({
      key: "hater",
      label: `${target.name} Hater`,
      emoji: "🔨",
      description: `Bans ${target.name} first, on sight, almost every game.`,
      detail: `first-banned ${target.name} in ${Math.round(rate * 100)}% of games`,
    });
  }
  // 🎲 Rando Brando — loves the random buttons.
  if (games >= 5 && randomGames / games >= 0.4) {
    traits.push({
      key: "rando-brando",
      label: "Rando Brando",
      emoji: "🎲",
      description: "Lets the dice decide — leans on the random pick/ban a lot.",
      detail: `random in ${Math.round((randomGames / games) * 100)}% of games`,
    });
  }

  return traits;
}
