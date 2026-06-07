// Fun "player traits" derived from a player's ban/pick behaviour across
// their confirmed matches. Purely cosmetic flavour — not used for anything
// scoring-related. Local Thunk would approve of the puns.
//
// Reads the relational model (Game + its GameDeck pool) — no JSON. Ban
// attribution is stored per pool row (bannedById / banOrdinal), so we never
// reconstruct it positionally. The OTHER (non-first) player makes the pick
// (the GameDeck row flagged `picked`). Shootouts are matches now, so they
// fold in automatically.
//
// Presentation (label / emoji / description / custom icon) layers on top of
// the TRAIT_REGISTRY catalog below: the code decides WHICH traits a player
// earns and the per-player `detail` stat line, while an admin can override
// any trait's label/emoji/description or upload a custom icon from
// /admin/traits (stored in TraitOverride, keyed by the trait's registry key).

import { prisma } from "@/lib/prisma";

export interface PlayerTrait {
  key: string;
  label: string;
  emoji: string;
  description: string;
  detail: string;
  // When set, a small (~48px) data: URL the profile renders in place of the
  // emoji. Comes from an admin override; null/undefined = show the emoji.
  iconDataUrl?: string | null;
}

// One catalog entry — the default presentation for a trait. The set of keys
// here IS the full universe of traits; /admin/traits lists exactly these.
export interface TraitDef {
  key: string;
  label: string;
  emoji: string;
  description: string;
}

// The trait catalog. Defaults only — per-trait admin edits live in
// TraitOverride and win over these at render time. `detail` is never stored
// here; it's the per-player stat line computed in loadPlayerTraits.
export const TRAIT_REGISTRY: TraitDef[] = [
  {
    key: "white-warrior",
    label: "White Stake Warrior",
    emoji: "🤍",
    description: "Picks the gentle stakes and bans the brutal ones — plays it safe.",
  },
  {
    key: "dr-spectred",
    label: "Dr. Spectred",
    emoji: "🎓",
    description: "PhD in Gold Stake from Balatro University.",
  },
  {
    key: "deck-loyalist",
    label: "Deck Loyalist",
    emoji: "🃏",
    description: "Always reaching for the same deck.",
  },
  {
    key: "wildcard",
    label: "Wildcard",
    emoji: "🌈",
    description: "Never the same deck twice — picks all over the place.",
  },
  {
    key: "ghostbuster",
    label: "Ghostbuster",
    emoji: "👻",
    description: "Bans the Ghost deck on sight — who you gonna call?",
  },
  {
    key: "banisher",
    label: "Banisher",
    emoji: "🔨",
    description: "First-bans a particular deck or stake almost every game — banishes it on sight.",
  },
  {
    key: "super-balatro-genius",
    label: "Super Balatro Genius",
    emoji: "🎲",
    description: "Lets the dice decide — leans on the random pick/ban a lot.",
  },
];
const REGISTRY_BY_KEY = new Map(TRAIT_REGISTRY.map((t) => [t.key, t]));

export interface TraitOverrideRow {
  key: string;
  label: string | null;
  emoji: string | null;
  description: string | null;
  iconDataUrl: string | null;
}

// Load every admin override once, keyed by trait key. Callers that compute
// traits for many players (the /admin/traits "who has what" view) should load
// this once and pass it into loadPlayerTraits to avoid N queries.
export async function loadTraitOverrides(): Promise<Map<string, TraitOverrideRow>> {
  // Degrade gracefully if the TraitOverride table isn't there yet (the brief
  // window where the web service has deployed the new code but the bot hasn't
  // run the migration). Traits are cosmetic, so falling back to code defaults
  // is far better than throwing on every profile render.
  try {
    const rows = await prisma.traitOverride.findMany({
      select: { key: true, label: true, emoji: true, description: true, iconDataUrl: true },
    });
    return new Map(rows.map((r) => [r.key, r]));
  } catch {
    return new Map();
  }
}

// Finish a trait by layering, in order of precedence: admin override → the
// per-player dynamic bits (only the Banisher has a dynamic label/description,
// for its specific target) → the registry default. `detail` is always the
// per-player stat line.
function makeTrait(
  key: string,
  detail: string,
  overrides: Map<string, TraitOverrideRow>,
  dynamic?: { label?: string; description?: string },
): PlayerTrait {
  const base = REGISTRY_BY_KEY.get(key);
  const ov = overrides.get(key);
  return {
    key,
    label: ov?.label ?? dynamic?.label ?? base?.label ?? key,
    emoji: ov?.emoji ?? base?.emoji ?? "🎭",
    description: ov?.description ?? dynamic?.description ?? base?.description ?? "",
    detail,
    iconDataUrl: ov?.iconDataUrl ?? null,
  };
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

export async function loadPlayerTraits(
  playerId: string,
  overridesInput?: Map<string, TraitOverrideRow>,
): Promise<PlayerTrait[]> {
  const overrides = overridesInput ?? (await loadTraitOverrides());

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
      winnerId: true,
      pickedRandomly: true,
      firstBannedRandomly: true,
      otherBannedRandomly: true,
      pool: { select: { deck: true, stake: true, picked: true, banOrdinal: true, bannedById: true } },
    },
  });

  const bannedStakes: Counts = {};
  const pickedStakes: Counts = {};
  const pickedDecks: Counts = {};
  const firstBannedDecks: Counts = {};
  const firstBannedStakes: Counts = {};
  const playedStakes: Counts = {}; // stake every game was played on (the picked combo)
  const wonStakes: Counts = {}; // …of those, the ones this player won
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
      // Every game the player was in counts toward "stakes they played on",
      // and a win on that stake toward "stakes they win on" (Dr. Spectred).
      bump(playedStakes, picked.stake);
      if (g.winnerId === playerId) bump(wonStakes, picked.stake);
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
    traits.push(makeTrait("white-warrior", `avg picked stake ${pickedAvg.toFixed(1)}/4`, overrides));
  }
  // 🎓 Dr. Spectred — PhD in Gold Stake from Balatro University. Awarded only
  // when Gold is BOTH this player's most-played stake AND their most-won
  // stake (with at least a couple of real Gold wins, not a one-off). Gold is
  // the hardest stake, so this is rare by design — exactly the point.
  const topPlayedStake = topEntry(playedStakes);
  const topWonStake = topEntry(wonStakes);
  if (topPlayedStake?.name === "Gold" && topWonStake?.name === "Gold" && topWonStake.count >= 2) {
    traits.push(
      makeTrait(
        "dr-spectred",
        `${topPlayedStake.count} games on Gold · ${topWonStake.count} wins on it`,
        overrides,
      ),
    );
  }
  // 🃏 Deck Loyalist — keeps reaching for the same deck. Shows the favourite.
  const topPick = topEntry(pickedDecks);
  if (topPick && totalPicks >= 5 && topPick.count / totalPicks >= 0.4) {
    traits.push(
      makeTrait(
        "deck-loyalist",
        `Favourite: ${topPick.name} (${Math.round((topPick.count / totalPicks) * 100)}% of picks)`,
        overrides,
      ),
    );
  }
  // 🌈 Wildcard — deliberately picks all over the place (opposite of the
  // Loyalist; distinct from Super Balatro Genius, who lets the dice decide).
  const distinctPicked = Object.keys(pickedDecks).length;
  if (totalPicks >= 6 && distinctPicked / totalPicks >= 0.75) {
    traits.push(
      makeTrait("wildcard", `${distinctPicked} different decks across ${totalPicks} picks`, overrides),
    );
  }
  // 👻 Ghostbuster — bans the Ghost deck whenever it shows up.
  if (ghostAvailable >= 4 && ghostBanned / ghostAvailable >= 0.6) {
    traits.push(
      makeTrait(
        "ghostbuster",
        `banned Ghost in ${Math.round((ghostBanned / ghostAvailable) * 100)}% of games it appeared`,
        overrides,
      ),
    );
  }
  // 🔨 {X} Banisher — consistently FIRST-bans a particular deck or stake.
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
    const description = `First-bans the ${target.name} ${useDeck ? "deck" : "stake"} almost every game — banishes it on sight.`;
    traits.push(
      makeTrait("banisher", `first-banned in ${Math.round(rate * 100)}% of games`, overrides, {
        label,
        description,
      }),
    );
  }
  // 🎲 Super Balatro Genius — loves the random buttons (lets the dice decide).
  if (games >= 5 && randomGames / games >= 0.4) {
    traits.push(
      makeTrait(
        "super-balatro-genius",
        `random in ${Math.round((randomGames / games) * 100)}% of games`,
        overrides,
      ),
    );
  }
  return traits;
}
