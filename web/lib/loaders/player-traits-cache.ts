// Cached read path for "fun player traits" (web/lib/trait-rules.ts decides;
// web/lib/loaders/player-traits.ts fetches + presents live). /me and
// /profile/[id] used to call loadPlayerTraits on every view, which scans
// every confirmed game the player has ever played — this wraps that in the
// SAME cold-read-computes-and-warms pattern as DivisionStandings
// (web/lib/standings-cache.ts): a cache hit is one indexed row read; a cache
// miss (first view, or a row older than STALE_AFTER_MS) recomputes and writes
// the cache so the next view is cheap. No dedicated "recompute on confirm"
// hook exists yet (that would mean wiring every web + bot match-confirm path
// — out of scope here); the TTL is the stand-in "nightly recompute" the task
// allowed as an alternative, except it self-heals on next view rather than
// running on a schedule.
//
// traitsJson stores ONLY the earned subset (key + detail) — label/emoji/
// description/icon still come from TRAIT_REGISTRY/TraitOverride at render
// time, so an admin override takes effect immediately without invalidating
// this cache.

import { prisma } from "@/lib/prisma";
import type { EarnedTrait } from "@/lib/trait-rules";
import {
  fetchTraitGames,
  loadTraitOverrides,
  presentEarnedTraits,
  type PlayerTrait,
  type TraitOverrideRow,
} from "@/lib/loaders/player-traits";
import { computeEarnedTraits } from "@/lib/trait-rules";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

function isFresh(computedAt: Date): boolean {
  return Date.now() - computedAt.getTime() < STALE_AFTER_MS;
}

// The earned-subset (key + detail), cached and reused by both the profile
// page and the /admin/traits "who has what" holder computation — callers that
// don't need presentation (traits-admin.ts) can use this directly instead of
// paying for makeTrait's registry/override lookups.
export async function loadEarnedTraitsCached(playerId: string): Promise<EarnedTrait[]> {
  const cached = await prisma.playerTraitsCache.findUnique({ where: { playerId } });
  if (cached && isFresh(cached.computedAt)) {
    try {
      return JSON.parse(cached.traitsJson) as EarnedTrait[];
    } catch {
      // Corrupt row — fall through and recompute.
    }
  }

  const games = await fetchTraitGames(playerId);
  const earned = computeEarnedTraits(playerId, games);
  await prisma.playerTraitsCache
    .upsert({
      where: { playerId },
      create: { playerId, traitsJson: JSON.stringify(earned) },
      update: { traitsJson: JSON.stringify(earned) },
    })
    .catch(() => {}); // best-effort warm — traits are cosmetic, never block the page on a write failure
  return earned;
}

// Cached + presented — what /me and /profile/[id] should call instead of
// loadPlayerTraits.
export async function loadPlayerTraitsCached(
  playerId: string,
  overridesInput?: Map<string, TraitOverrideRow>,
): Promise<PlayerTrait[]> {
  const [earned, overrides] = await Promise.all([
    loadEarnedTraitsCached(playerId),
    overridesInput ? Promise.resolve(overridesInput) : loadTraitOverrides(),
  ]);
  return presentEarnedTraits(earned, overrides);
}
