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
import { computeEarnedTraits, topStakeDeterministic, type EarnedTrait, type TraitGameRow } from "@/lib/trait-rules";

export { topStakeDeterministic };

export interface PlayerTrait {
  key: string;
  label: string;
  emoji: string;
  description: string;
  detail: string;
  // Plain-language description of how the trait is earned (the gating rule).
  // Not admin-editable — it documents the code logic. Shown on the profile
  // tooltip + the /admin/traits catalog.
  criteria: string;
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
  criteria: string;
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
    criteria: "After 10+ games, White is both your most-played and most-won stake.",
  },
  {
    key: "dr-spectred",
    label: "Dr. Spectred",
    emoji: "🎓",
    description: "PhD in Gold Stake from Balatro University.",
    criteria: "After 10+ games, Gold is both your most-played and most-won stake.",
  },
  {
    key: "ghostbuster",
    label: "Ghostbuster",
    emoji: "👻",
    description: "Who you gonna call?",
    criteria: "After 10+ games, you've banned the Ghost deck in most games it appeared.",
  },
  {
    key: "super-balatro-genius",
    label: "Super Balatro Genius",
    emoji: "🎲",
    description: "Doesn't care what the deck or stake is, they will beat you.",
    criteria: "After 10+ games, you random-pick most of your picks and win most of them.",
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
    criteria: base?.criteria ?? "",
    detail,
    iconDataUrl: ov?.iconDataUrl ?? null,
  };
}

// Layer admin overrides onto an already-decided earned-traits list (presentation
// only — the earn/no-earn decision + detail text came from computeEarnedTraits).
export function presentEarnedTraits(earned: EarnedTrait[], overrides: Map<string, TraitOverrideRow>): PlayerTrait[] {
  return earned.map((t) => makeTrait(t.key, t.detail, overrides));
}

// The game-fetch shared by loadPlayerTraits (live) and the cache's cold path
// (web/lib/loaders/player-traits-cache.ts) — reads the player's games
// relationally (Game + its full GameDeck pool), no JSON parsing. Shootouts
// fold in automatically (they're matches now). Only confirmed, non-DC games
// count. This is the expensive full-game-table scan the cache exists to avoid
// paying on every profile view.
export async function fetchTraitGames(playerId: string): Promise<TraitGameRow[]> {
  return prisma.game.findMany({
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
}

// Live (uncached) trait computation — fetches + decides + presents every
// call. Used by the cache's cold path and any caller that genuinely wants a
// live read. Profile pages should prefer loadPlayerTraitsCached instead (see
// player-traits-cache.ts) to avoid the full game-table scan on every view.
export async function loadPlayerTraits(
  playerId: string,
  overridesInput?: Map<string, TraitOverrideRow>,
): Promise<PlayerTrait[]> {
  const overrides = overridesInput ?? (await loadTraitOverrides());
  const playerGames = await fetchTraitGames(playerId);
  const earned = computeEarnedTraits(playerId, playerGames);
  return presentEarnedTraits(earned, overrides);
}
