// Fun "player traits" derived from a player's ban/pick behaviour across
// their confirmed matches. Purely cosmetic flavour — not used for anything
// scoring-related. Local Thunk would approve of the puns.
//
// Reads the relational model (Game + its GameDeck pool) — no JSON. Ban
// attribution is stored per pool row (bannedById / banOrdinal), so we never
// reconstruct it positionally. The OTHER (non-first) player makes the pick
// (the GameDeck row flagged `picked`). Shootouts are matches now, so they
// fold in automatically.

import { prisma } from "@/lib/prisma";

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
  // Read the player's games relationally (Game + its full GameDeck pool) —
  // no JSON parsing. Shootouts fold in automatically (they're matches now).
  // Only confirmed, non-DC games count. Ban attribution lives on each
  // GameDeck row (bannedById / banOrdinal), so we never reconstruct it.
  const playerGames = await prisma.game.findMany({
    where: {
      dcByPlayerId: null,
      match: { status: "CONFIRMED", OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    },
    select: {
      firstPlayerId: true,
      pickedRandomly: true,
      firstBannedRandomly: true,
      otherBannedRandomly: true,
      pool: { select: { deck: true, stake: true, picked: true, banOrdinal: true, bannedById: true } },
    },
  });

  const bannedStakes: Counts = {};
  const pickedStakes: Counts = {};
  const pickedDecks: Counts = {};
  const playedCombos: Counts = {}; // deck+stake the game was actually played on
  const firstBannedDecks: Counts = {};
  const firstBannedStakes: Counts = {};
  let totalPicks = 0;
  let games = 0;
  let randomGames = 0;
  let ghostAvailable = 0; // games where the Ghost deck was in the pool
  let ghostBanned = 0; // …of those, how many this player banned it

  for (const g of playerGames) {
    if (g.pool.length === 0) continue;
    games++;
    const isFirst = g.firstPlayerId === playerId;

    // This player's bans — attribution is stored on each GameDeck row.
    const myBans = g.pool.filter((d) => d.bannedById === playerId);
    for (const d of myBans) bump(bannedStakes, d.stake);

    // Their FIRST ban = the one with the smallest ban turn order.
    let firstBan: (typeof myBans)[number] | null = null;
    let firstBanOrd = Infinity;
    for (const d of myBans) {
      if (d.banOrdinal == null) continue;
      if (d.banOrdinal < firstBanOrd) {
        firstBanOrd = d.banOrdinal;
        firstBan = d;
      }
    }
    if (firstBan) {
      bump(firstBannedDecks, firstBan.deck);
      bump(firstBannedStakes, firstBan.stake);
    }

    // Ghostbuster — Ghost available in the pool vs. this player banning it.
    const ghostRow = g.pool.find((d) => d.deck === "Ghost");
    if (ghostRow) {
      ghostAvailable++;
      if (ghostRow.bannedById === playerId) ghostBanned++;
    }

    // The picked combo (what the game was played on).
    const picked = g.pool.find((d) => d.picked);
    if (picked) {
      bump(playedCombos, `${picked.deck} · ${picked.stake}`);
      // Only the OTHER (non-first) player makes the final pick.
      if (!isFirst) {
        bump(pickedStakes, picked.stake);
        bump(pickedDecks, picked.deck);
        totalPicks++;
      }
    }

    // 🎲 random-button usage this game.
    const usedRandom = isFirst ? !!g.firstBannedRandomly : !!g.otherBannedRandomly || !!g.pickedRandomly;
    if (usedRandom) randomGames++;
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
  // 🎩 Dr. Spectre — the mirror of the White Stake Warrior: picks the
  // brutal stakes and bans the gentle ones. Lives for the high stakes.
  if (pickedAvg !== null && bannedAvg !== null && totalPicks >= 4 && pickedAvg >= 2.8 && bannedAvg <= 1.6) {
    traits.push({
      key: "dr-spectre",
      label: "Dr. Spectre",
      emoji: "🎩",
      description: "Picks the brutal stakes and bans the gentle ones — lives for the high stakes.",
      detail: `avg picked stake ${pickedAvg.toFixed(1)}/4, banned ${bannedAvg.toFixed(1)}/4`,
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
  // 🌈 Wildcard — deliberately picks all over the place (opposite of the
  // Loyalist; distinct from Rando Brando, who lets the dice decide).
  const distinctPicked = Object.keys(pickedDecks).length;
  if (totalPicks >= 6 && distinctPicked / totalPicks >= 0.75) {
    traits.push({
      key: "wildcard",
      label: "Wildcard",
      emoji: "🌈",
      description: "Never the same deck twice — picks all over the place.",
      detail: `${distinctPicked} different decks across ${totalPicks} picks`,
    });
  }
  // 👻 Ghostbuster — bans the Ghost deck whenever it shows up.
  if (ghostAvailable >= 4 && ghostBanned / ghostAvailable >= 0.6) {
    traits.push({
      key: "ghostbuster",
      label: "Ghostbuster",
      emoji: "👻",
      description: "Bans the Ghost deck on sight — who you gonna call?",
      detail: `banned Ghost in ${Math.round((ghostBanned / ghostAvailable) * 100)}% of games it appeared`,
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
    // Always qualify with "Deck"/"Stake" so a color-named one (Black, Gold,
    // White, …) reads unmistakably as a Balatro thing, never a slur.
    const label = useDeck ? `${target.name} Deck Banisher` : `${target.name} Stake Banisher`;
    traits.push({
      key: "banisher",
      label,
      emoji: "🔨",
      description: `First-bans the ${target.name} ${useDeck ? "deck" : "stake"} almost every game — banishes it on sight.`,
      detail: `first-banned in ${Math.round(rate * 100)}% of games`,
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
  // 🎯 Signature Combo — the deck+stake this player has played on most.
  // Informational (not a quirk), so it's always shown once there's enough
  // history to make "most-played" meaningful.
  const topCombo = topEntry(playedCombos);
  if (games >= 6 && topCombo) {
    traits.push({
      key: "signature-combo",
      label: `Signature: ${topCombo.name}`,
      emoji: "🎯",
      description: "The deck + stake they've played on most.",
      detail: `played ${topCombo.count}× (${Math.round((topCombo.count / games) * 100)}% of games)`,
    });
  }

  return traits;
}
