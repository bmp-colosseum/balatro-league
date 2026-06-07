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

// The three starter presets, one per role. "Standard" is the MANAGED canonical
// pool — force-synced to match-defaults.json on every boot, so its name is
// load-bearing (don't rename it in the UI; it'd get re-created). "Challenge"
// and "Custom" are seeded from the defaults once, then freely editable.
const STANDARD_NAME = "Standard";
const CHALLENGE_NAME = "Challenge";
const CUSTOM_NAME = "Custom";
// Older names the managed pool used — auto-renamed to "Standard" on boot.
const LEGACY_STANDARD_NAMES = ["League decks", "Stock"];

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

// Custom-combo "agree on a specific deck/stake" picker resolution. Its own
// role so admins can offer exotic stakes there without touching /challenge:
//   1. LeagueConfig.CustomComboPresetId — admin's chosen custom-combo preset
//   2. The casual preset (back-compat: behaves as before until a custom one
//      is set)
//   3. Any single existing preset
export async function presetForCustomCombo() {
  const id = await getConfig(LeagueConfigKey.CustomComboPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return preset;
  }
  return presetForCasualMatch();
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

// Bootstrap + keep the canonical pool in sync. The "League decks" preset is
// the managed default — it's force-synced to match-defaults.json on every
// boot, so editing that file and redeploying actually updates the live
// pool. (The old behavior only seeded once, so a stale pool stuck forever
// even across test-env wipes, which preserve presets.) Admins who want a
// different pool make a SEPARATE named preset and point a role at it; the
// managed one stays canonical.
export async function bootstrapPresetsAndPointers(): Promise<void> {
  // One-time migration: rename a legacy managed preset ("Stock" / "League
  // decks") to "Standard" so we keep managing the same row, not a duplicate.
  if (!(await prisma.matchConfigPreset.findUnique({ where: { name: STANDARD_NAME } }))) {
    for (const legacyName of LEGACY_STANDARD_NAMES) {
      const legacy = await prisma.matchConfigPreset.findUnique({ where: { name: legacyName } });
      if (legacy) {
        await prisma.matchConfigPreset.update({ where: { id: legacy.id }, data: { name: STANDARD_NAME } });
        break;
      }
    }
  }

  // Standard = the MANAGED canonical pool, force-synced to defaults each boot.
  let standard = await prisma.matchConfigPreset.findUnique({ where: { name: STANDARD_NAME } });
  standard = standard
    ? await prisma.matchConfigPreset.update({
        where: { id: standard.id },
        data: { decks: defaults.decks, stakes: defaults.stakes },
      })
    : await prisma.matchConfigPreset.create({
        data: { name: STANDARD_NAME, decks: defaults.decks, stakes: defaults.stakes },
      });

  // Challenge + Custom = seeded from the defaults ONCE, then freely editable
  // (not force-synced, so admin edits stick).
  const challenge = await ensureSeededPreset(CHALLENGE_NAME);
  const custom = await ensureSeededPreset(CUSTOM_NAME);

  // Point each role at its own preset. Repoint when the role is unset OR still
  // sharing one of the seeded defaults — so existing installs split apart
  // automatically — but leave a deliberate admin assignment alone.
  await pointRole(LeagueConfigKey.SeasonDefaultPresetId, standard.id, [null]);
  await pointRole(LeagueConfigKey.CasualPresetId, challenge.id, [null, standard.id]);
  await pointRole(LeagueConfigKey.CustomComboPresetId, custom.id, [null, standard.id, challenge.id]);
}

// Create a preset seeded from the canonical defaults if one with this name
// doesn't exist yet; otherwise leave it untouched (admin edits persist).
async function ensureSeededPreset(name: string) {
  const existing = await prisma.matchConfigPreset.findUnique({ where: { name } });
  if (existing) return existing;
  return prisma.matchConfigPreset.create({
    data: { name, decks: defaults.decks, stakes: defaults.stakes },
  });
}

// Set a role pointer to presetId when it's unset or currently points at one of
// `repointFrom` (the shared seeds). A deliberate assignment to any other preset
// is left alone.
async function pointRole(
  key: LeagueConfigKey,
  presetId: string,
  repointFrom: (string | null)[],
): Promise<void> {
  const current = (await getConfig(key)) ?? null;
  if (current !== null && !repointFrom.includes(current)) return;
  if (current === presetId) return;
  await prisma.leagueConfig.upsert({
    where: { key },
    create: { key, value: presetId, updatedBy: "bootstrap" },
    update: { value: presetId },
  });
}
