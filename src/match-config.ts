// Deck/stake preset config + pool generation.
//
// Presets are named bundles of decks + stakes. The NAME has no
// semantic meaning — admin can call them whatever they want. Which
// preset is the "season default" and which is the "casual default"
// is configured via LeagueConfig pointers:
//   season_default_preset_id  — fallback for /start-match when a
//                               season doesn't pick a specific one
//   casual_preset_id          — used by /challenge
// Both pointers can be moved freely on /admin/deck-bans.

import { prisma } from "./db.js";
import defaults from "./data/match-defaults.json" with { type: "json" };
import { getConfig, LeagueConfigKey } from "./league-config.js";

export const DEFAULT_POOL_SIZE = 9;

// Name used by the one-shot auto-seed when NO presets exist at all.
// Admin can rename it freely afterwards — nothing depends on this
// string being a specific value at runtime.
const STOCK_SEED_NAME = "Stock";

export interface DeckEntry {
  deck: string;
  stake: string;
}

// Resolve which preset a season uses for /start-match:
//   1. Season.matchConfigPresetId — admin's per-season choice
//   2. LeagueConfig.SeasonDefaultPresetId — league-wide fallback
//   3. Any single existing preset (last-resort if config is empty)
// Returns null if no presets exist anywhere.
export async function presetForSeason(seasonId: string) {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: { matchConfigPreset: true },
  });
  if (season?.matchConfigPreset) return season.matchConfigPreset;
  return resolveDefaultSeasonPreset();
}

// Same as presetForSeason, but starting from a division id.
export async function presetForDivision(divisionId: string) {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { seasonId: true },
  });
  if (!division) return null;
  return presetForSeason(division.seasonId);
}

// /challenge resolution — purely config-driven, no season context.
//   1. LeagueConfig.CasualPresetId — admin's chosen casual preset
//   2. Any single existing preset (last-resort)
export async function presetForCasualMatch() {
  const id = await getConfig(LeagueConfigKey.CasualPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return preset;
  }
  return firstExistingPreset();
}

export async function resolveDefaultSeasonPreset() {
  const id = await getConfig(LeagueConfigKey.SeasonDefaultPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return preset;
  }
  return firstExistingPreset();
}

async function firstExistingPreset() {
  return prisma.matchConfigPreset.findFirst({ orderBy: { createdAt: "asc" } });
}

// Cartesian product of (deck × stake), shuffled and sliced. No duplicate combos.
// excludeDecks: deck NAMES to skip — used by game 2/3 to avoid repeating any
// deck that already showed up in a prior game's pool. If filtering would
// leave too few combos to fill `size`, we fall back to including the
// excluded decks so the match can still proceed.
export function generatePool(
  decks: string[],
  stakes: string[],
  size: number = DEFAULT_POOL_SIZE,
  rand: () => number = Math.random,
  excludeDecks: string[] = [],
): DeckEntry[] {
  const excluded = new Set(excludeDecks);
  const filteredDecks = decks.filter((d) => !excluded.has(d));
  // Only honor the exclusion if the filtered set can still fill the pool.
  // Otherwise fall back to the full deck list so the match doesn't stall.
  const usable = filteredDecks.length * stakes.length >= size ? filteredDecks : decks;
  const combos: DeckEntry[] = [];
  for (const deck of usable) {
    for (const stake of stakes) {
      combos.push({ deck, stake });
    }
  }
  if (combos.length < size) return shuffle(combos, rand);
  return shuffle(combos, rand).slice(0, size);
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Bootstrap + keep the canonical pool in sync. The "Stock" preset is the
// managed default — it's force-synced to match-defaults.json on every
// boot, so editing that file and redeploying actually updates the live
// pool. (The old behavior only seeded once, so a stale pool stuck forever
// even across test-env wipes, which preserve presets.) Admins who want a
// different pool make a SEPARATE named preset and point a role at it;
// Stock stays canonical.
export async function bootstrapPresetsAndPointers(): Promise<void> {
  let anchor = await prisma.matchConfigPreset.findUnique({ where: { name: STOCK_SEED_NAME } });

  if (!anchor) {
    // Missing (fresh DB, or some other preset exists but Stock was never
    // created) — create it from the canonical defaults.
    anchor = await prisma.matchConfigPreset.create({
      data: { name: STOCK_SEED_NAME, decks: defaults.decks, stakes: defaults.stakes },
    });
  } else {
    // Force-sync to the canonical pool so the defaults file is the single
    // source of truth.
    anchor = await prisma.matchConfigPreset.update({
      where: { id: anchor.id },
      data: { decks: defaults.decks, stakes: defaults.stakes },
    });
  }

  // Point the LeagueConfig keys at the anchor preset, but ONLY if
  // they're currently unset — admin's existing choices win.
  const existingSeasonId = await getConfig(LeagueConfigKey.SeasonDefaultPresetId);
  const existingCasualId = await getConfig(LeagueConfigKey.CasualPresetId);
  if (!existingSeasonId) {
    await prisma.leagueConfig.upsert({
      where: { key: LeagueConfigKey.SeasonDefaultPresetId },
      create: { key: LeagueConfigKey.SeasonDefaultPresetId, value: anchor.id, updatedBy: "bootstrap" },
      update: { value: anchor.id },
    });
  }
  if (!existingCasualId) {
    await prisma.leagueConfig.upsert({
      where: { key: LeagueConfigKey.CasualPresetId },
      create: { key: LeagueConfigKey.CasualPresetId, value: anchor.id, updatedBy: "bootstrap" },
      update: { value: anchor.id },
    });
  }
}
