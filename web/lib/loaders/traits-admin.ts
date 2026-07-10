// Loader for /admin/traits + the public /traits guide — the trait catalog
// (registry merged with admin overrides) plus the "who currently has each
// trait" lists.
//
// Holders are computed by running the SAME loadPlayerTraits() the profile uses,
// once per veteran player, so the two surfaces can NEVER disagree (they used to
// have parallel SQL that drifted — different tie-breaks + game counts). We first
// cheaply narrow to players with enough confirmed games (only they can earn a
// trait), so this stays bounded by the veteran count, not the whole roster.

import { prisma } from "@/lib/prisma";
import {
  TRAIT_REGISTRY,
  loadTraitOverrides,
  loadPlayerTraits,
  type TraitOverrideRow,
} from "./player-traits";

export interface TraitHolder {
  id: string;
  name: string;
  discordId: string;
  username: string | null;
}

export interface TraitAdminRow {
  key: string;
  // Effective (override-or-default) presentation.
  label: string;
  emoji: string;
  description: string;
  iconDataUrl: string | null;
  // Plain-language gating rule (how the trait is earned). Read-only.
  criteria: string;
  // The code defaults, so the editor can show "default: …" hints.
  defaultLabel: string;
  defaultEmoji: string;
  defaultDescription: string;
  // True if any override row exists for this key.
  overridden: boolean;
  // Players who currently earn this trait, by display name.
  holders: TraitHolder[];
}

const GAMES_FLOOR = 10; // matches loadPlayerTraits — traits need 10+ games

// Compute the holder set for every trait. Passes the pre-loaded overrides into
// loadPlayerTraits so it isn't re-queried per player.
async function computeTraitHolders(
  overrides: Map<string, TraitOverrideRow>,
): Promise<Map<string, TraitHolder[]>> {
  // Candidate players: enough confirmed, non-DC games with a pool that they
  // COULD clear the floor. loadPlayerTraits re-applies the real >= 10 gate, so
  // this is just a cheap pre-filter (same game-counting rule, so no boundary
  // player is missed). Explodes each game into its two participants.
  const candidates = await prisma.$queryRaw<{ player_id: string }[]>`
    SELECT player_id FROM (
      SELECT m."playerAId" AS player_id FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
        WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
          AND EXISTS (SELECT 1 FROM "GameDeck" gd WHERE gd."gameId" = g.id)
      UNION ALL
      SELECT m."playerBId" FROM "Game" g JOIN "Match" m ON m.id = g."matchId"
        WHERE m.status::text = 'CONFIRMED' AND g."dcByPlayerId" IS NULL
          AND EXISTS (SELECT 1 FROM "GameDeck" gd WHERE gd."gameId" = g.id)
    ) t GROUP BY player_id HAVING COUNT(*) >= ${GAMES_FLOOR}
  `;

  const holderIds: Record<string, Set<string>> = {
    "white-warrior": new Set(),
    "dr-spectred": new Set(),
    "ghostbuster": new Set(),
    "super-balatro-genius": new Set(),
  };

  // ONE code path with the profile — compute each candidate's traits exactly as
  // loadPlayerTraits does. Bounded by the veteran count (players with 10+ games).
  for (const c of candidates) {
    const traits = await loadPlayerTraits(c.player_id, overrides);
    for (const t of traits) holderIds[t.key]?.add(c.player_id);
  }

  // Resolve display names for just the holders (one query).
  const allIds = new Set<string>();
  for (const set of Object.values(holderIds)) for (const id of set) allIds.add(id);
  const names = allIds.size
    ? await prisma.player.findMany({
        where: { id: { in: [...allIds] } },
        select: { id: true, displayName: true, discordId: true, username: true },
      })
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.displayName]));
  const discordById = new Map(names.map((n) => [n.id, n.discordId]));
  const usernameById = new Map(names.map((n) => [n.id, n.username]));

  const result = new Map<string, TraitHolder[]>();
  for (const [key, ids] of Object.entries(holderIds)) {
    const arr = [...ids]
      .map((id) => ({
        id,
        name: nameById.get(id) ?? id,
        discordId: discordById.get(id) ?? "",
        username: usernameById.get(id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    result.set(key, arr);
  }
  return result;
}

export async function loadTraitsAdmin(): Promise<TraitAdminRow[]> {
  const overrides = await loadTraitOverrides();

  // Holders are a best-effort overlay — never let them break the page; the
  // catalog (labels/criteria/icons) always renders.
  let holdersByKey = new Map<string, TraitHolder[]>();
  try {
    holdersByKey = await computeTraitHolders(overrides);
  } catch {
    holdersByKey = new Map();
  }

  return TRAIT_REGISTRY.map((def) => {
    const ov = overrides.get(def.key);
    return {
      key: def.key,
      label: ov?.label ?? def.label,
      emoji: ov?.emoji ?? def.emoji,
      description: ov?.description ?? def.description,
      iconDataUrl: ov?.iconDataUrl ?? null,
      criteria: def.criteria,
      defaultLabel: def.label,
      defaultEmoji: def.emoji,
      defaultDescription: def.description,
      overridden: !!ov,
      holders: holdersByKey.get(def.key) ?? [],
    };
  });
}
