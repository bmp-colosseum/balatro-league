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
//
// The pure pool-GENERATION engine (generatePool, checkPoolPolicyFeasibility,
// BMP_POOL, the DeckWeight/PoolPolicy types, …) lives in ./match-pool.ts —
// re-exported below (`export *`) so every existing `from "./match-config.js"`
// import keeps working unchanged. This file keeps only what genuinely needs
// prisma: resolving which preset a season/match uses, and bootstrapping the
// starter presets. See match-pool.ts's header for why the split exists (it's
// synced verbatim to web/lib/match-pool.ts; this file, with its prisma
// import, is not).

import { prisma } from "./db.js";
import type { MatchConfigPreset } from "@prisma/client";
import defaults from "./data/match-defaults.json" with { type: "json" };
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { parseDeckWeightsJson, parsePoolPolicyJson } from "./deck-pool-config-core.js";
import type { DeckWeight, PoolPolicy } from "./match-pool.js";

export * from "./match-pool.js";

// The three starter presets, one per role. "Standard" is the MANAGED canonical
// pool — force-synced to match-defaults.json on every boot, so its name is
// load-bearing (don't rename it in the UI; it'd get re-created). "Challenge"
// and "Custom" are seeded from the defaults once, then freely editable.
const STANDARD_NAME = "Standard";
const CHALLENGE_NAME = "Challenge";
const CUSTOM_NAME = "Custom";
// Older names the managed pool used — auto-renamed to "Standard" on boot.
const LEGACY_STANDARD_NAMES = ["League decks", "Stock"];

// A MatchConfigPreset row as every resolver below hands it to callers: the
// raw JSON-as-text deckWeights/poolPolicy columns replaced by their PARSED
// values, so nothing downstream ever re-parses or trusts the column
// verbatim. A preset with both columns unset (every preset created before
// this feature, or one an admin has never touched) parses to `[]`/`{}` —
// byte-identical to this resolver's behavior before these columns existed.
export interface ResolvedPreset {
  id: string;
  name: string;
  decks: string[];
  stakes: string[];
  deckWeights: DeckWeight[];
  poolPolicy: PoolPolicy;
  createdAt: Date;
  updatedAt: Date;
}

function withParsedPool(preset: MatchConfigPreset): ResolvedPreset;
function withParsedPool(preset: MatchConfigPreset | null): ResolvedPreset | null;
function withParsedPool(preset: MatchConfigPreset | null): ResolvedPreset | null {
  if (!preset) return null;
  return {
    id: preset.id,
    name: preset.name,
    decks: preset.decks,
    stakes: preset.stakes,
    deckWeights: parseDeckWeightsJson(preset.deckWeights),
    poolPolicy: parsePoolPolicyJson(preset.poolPolicy ?? null),
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

// Resolve which preset a season uses for /start-match:
//   1. Season.matchConfigPresetId — admin's per-season choice
//   2. LeagueConfig.SeasonDefaultPresetId — league-wide fallback
//   3. Any single existing preset (last-resort if config is empty)
// Returns null if no presets exist anywhere.
export async function presetForSeason(seasonId: string): Promise<ResolvedPreset | null> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: { matchConfigPreset: true },
  });
  if (season?.matchConfigPreset) return withParsedPool(season.matchConfigPreset);
  return resolveDefaultSeasonPreset();
}

// Same as presetForSeason, but starting from a division id.
export async function presetForDivision(divisionId: string): Promise<ResolvedPreset | null> {
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
export async function presetForCasualMatch(): Promise<ResolvedPreset | null> {
  const id = await getConfig(LeagueConfigKey.CasualPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return withParsedPool(preset);
  }
  return firstExistingPreset();
}

// Custom-combo "agree on a specific deck/stake" picker resolution. Its own
// role so admins can offer exotic stakes there without touching /challenge:
//   1. LeagueConfig.CustomComboPresetId — admin's chosen custom-combo preset
//   2. The casual preset (back-compat: behaves as before until a custom one
//      is set)
//   3. Any single existing preset
export async function presetForCustomCombo(): Promise<ResolvedPreset | null> {
  const id = await getConfig(LeagueConfigKey.CustomComboPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return withParsedPool(preset);
  }
  return presetForCasualMatch();
}

export async function resolveDefaultSeasonPreset(): Promise<ResolvedPreset | null> {
  const id = await getConfig(LeagueConfigKey.SeasonDefaultPresetId);
  if (id) {
    const preset = await prisma.matchConfigPreset.findUnique({ where: { id } });
    if (preset) return withParsedPool(preset);
  }
  return firstExistingPreset();
}

async function firstExistingPreset(): Promise<ResolvedPreset | null> {
  const preset = await prisma.matchConfigPreset.findFirst({ orderBy: { createdAt: "asc" } });
  return withParsedPool(preset);
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
