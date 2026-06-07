// Loader for /admin/traits — the trait editor + "who has what" overview.
// Merges the code TRAIT_REGISTRY catalog with any admin TraitOverride rows,
// and buckets every player who currently earns each trait.

import { prisma } from "@/lib/prisma";
import { TRAIT_REGISTRY, loadPlayerTraits, loadTraitOverrides } from "./player-traits";

export interface TraitHolder {
  id: string;
  name: string;
}

export interface TraitAdminRow {
  key: string;
  // Effective (override-or-default) presentation.
  label: string;
  emoji: string;
  description: string;
  iconDataUrl: string | null;
  // The code defaults, so the editor can show "default: …" hints.
  defaultLabel: string;
  defaultEmoji: string;
  defaultDescription: string;
  // True if any override row exists for this key.
  overridden: boolean;
  // Players who currently earn this trait, by display name.
  holders: TraitHolder[];
}

export async function loadTraitsAdmin(): Promise<TraitAdminRow[]> {
  const overrides = await loadTraitOverrides();

  // Only consider players with at least one confirmed match — everyone else
  // earns nothing anyway (the trait floor is 4 games).
  const players = await prisma.player.findMany({
    where: {
      OR: [
        { matchesAsA: { some: { status: "CONFIRMED" } } },
        { matchesAsB: { some: { status: "CONFIRMED" } } },
      ],
    },
    select: { id: true, displayName: true },
  });

  // Compute each player's traits once (sharing the overrides map) and bucket
  // holders by trait key. O(players) Game queries — fine for an admin page on
  // a real-sized league; if the league ever gets huge, precompute/cache here.
  const holdersByKey = new Map<string, TraitHolder[]>();
  await Promise.all(
    players.map(async (p) => {
      const traits = await loadPlayerTraits(p.id, overrides);
      for (const t of traits) {
        const arr = holdersByKey.get(t.key) ?? [];
        arr.push({ id: p.id, name: p.displayName });
        holdersByKey.set(t.key, arr);
      }
    }),
  );
  for (const arr of holdersByKey.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

  return TRAIT_REGISTRY.map((def) => {
    const ov = overrides.get(def.key);
    return {
      key: def.key,
      label: ov?.label ?? def.label,
      emoji: ov?.emoji ?? def.emoji,
      description: ov?.description ?? def.description,
      iconDataUrl: ov?.iconDataUrl ?? null,
      defaultLabel: def.label,
      defaultEmoji: def.emoji,
      defaultDescription: def.description,
      overridden: !!ov,
      holders: holdersByKey.get(def.key) ?? [],
    };
  });
}
