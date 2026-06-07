// Fun "player traits" derived from a player's ban/pick + win behaviour across
// their confirmed matches. Purely cosmetic flavour — not used for anything
// scoring-related. Local Thunk would approve of the puns.
//
// Reads the relational model (Game + its GameDeck pool) — no JSON. Ban
// attribution is stored per pool row (bannedById), and the picked combo is the
// GameDeck row flagged `picked`. Shootouts are matches now, so they fold in
// automatically.
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
    description: "Will beat you… as long as it's on White stake.",
  },
  {
    key: "dr-spectred",
    label: "Dr. Spectred",
    emoji: "🎓",
    description: "PhD in Gold Stake from Balatro University.",
  },
  {
    key: "ghostbuster",
    label: "Ghostbuster",
    emoji: "👻",
    description: "Bans the Ghost deck on sight — who you gonna call?",
  },
  {
    key: "super-balatro-genius",
    label: "Super Balatro Genius",
    emoji: "🎲",
    description: "Doesn't care what the deck or stake is, they will beat you.",
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

// Finish a trait by layering admin override → registry default. `detail` is
// always the per-player stat line.
function makeTrait(key: string, detail: string, overrides: Map<string, TraitOverrideRow>): PlayerTrait {
  const base = REGISTRY_BY_KEY.get(key);
  const ov = overrides.get(key);
  return {
    key,
    label: ov?.label ?? base?.label ?? key,
    emoji: ov?.emoji ?? base?.emoji ?? "🎭",
    description: ov?.description ?? base?.description ?? "",
    detail,
    iconDataUrl: ov?.iconDataUrl ?? null,
  };
}

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

export async function loadPlayerTraits(
  playerId: string,
  overridesInput?: Map<string, TraitOverrideRow>,
): Promise<PlayerTrait[]> {
  const overrides = overridesInput ?? (await loadTraitOverrides());

  // Read the player's games relationally (Game + its full GameDeck pool) —
  // no JSON parsing. Shootouts fold in automatically (they're matches now).
  // Only confirmed, non-DC games count.
  const playerGames = await prisma.game.findMany({
    where: {
      dcByPlayerId: null,
      match: { status: "CONFIRMED", OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    },
    select: {
      firstPlayerId: true,
      winnerId: true,
      pickedRandomly: true,
      pool: { select: { deck: true, stake: true, picked: true, bannedById: true } },
    },
  });

  const playedStakes: Counts = {}; // stake every game was played on (the picked combo)
  const wonStakes: Counts = {}; // …of those, the ones this player won
  let totalPicks = 0; // games this player was the picker (non-first)
  let games = 0;
  let randomPicks = 0; // …of those, picked via the random button
  let randomPickWins = 0; // …of those, how many they won
  let ghostAvailable = 0; // games where the Ghost deck was in the pool
  let ghostBanned = 0; // …of those, how many this player banned it

  for (const g of playerGames) {
    if (g.pool.length === 0) continue;
    games++;
    const isFirst = g.firstPlayerId === playerId;

    // Ghostbuster — Ghost available in the pool vs. this player banning it.
    const ghostRow = g.pool.find((d) => d.deck === "Ghost");
    if (ghostRow) {
      ghostAvailable++;
      if (ghostRow.bannedById === playerId) ghostBanned++;
    }

    // The picked combo (what the game was played on).
    const picked = g.pool.find((d) => d.picked);
    if (picked) {
      bump(playedStakes, picked.stake);
      if (g.winnerId === playerId) bump(wonStakes, picked.stake);
      // Only the OTHER (non-first) player makes the final pick.
      if (!isFirst) {
        totalPicks++;
        if (g.pickedRandomly) {
          randomPicks++;
          if (g.winnerId === playerId) randomPickWins++;
        }
      }
    }
  }

  if (games < 4) return []; // not enough signal yet

  const traits: PlayerTrait[] = [];
  const topPlayedStake = topEntry(playedStakes);
  const topWonStake = topEntry(wonStakes);

  // 🤍 White Stake Warrior — White is BOTH their most-played and most-won
  // stake. Will beat you… as long as it's on White (the gentle stake). The
  // self-deprecating mirror of Dr. Spectred, who does it on Gold.
  if (topPlayedStake?.name === "White" && topWonStake?.name === "White" && topWonStake.count >= 2) {
    traits.push(
      makeTrait(
        "white-warrior",
        `${topPlayedStake.count} games on White · ${topWonStake.count} wins on it`,
        overrides,
      ),
    );
  }
  // 🎓 Dr. Spectred — PhD in Gold Stake. Gold is BOTH most-played and most-won
  // (with a couple of real Gold wins). Gold is the hardest stake → rare.
  if (topPlayedStake?.name === "Gold" && topWonStake?.name === "Gold" && topWonStake.count >= 2) {
    traits.push(
      makeTrait(
        "dr-spectred",
        `${topPlayedStake.count} games on Gold · ${topWonStake.count} wins on it`,
        overrides,
      ),
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
  // 🎲 Super Balatro Genius — random-picks more often than not AND wins the
  // majority of those games. Doesn't care what the deck or stake is.
  if (
    totalPicks >= 5 &&
    randomPicks >= 3 &&
    randomPicks / totalPicks >= 0.5 &&
    randomPickWins >= 2 &&
    randomPickWins / randomPicks >= 0.5
  ) {
    traits.push(
      makeTrait("super-balatro-genius", `won ${randomPickWins} of ${randomPicks} random picks`, overrides),
    );
  }
  return traits;
}
