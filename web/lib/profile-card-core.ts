// Pure helpers for the v2 player-profile hero card (see ProfileView.tsx).
// No framework/DB imports here -- every function takes plain data and
// returns plain data, so a unit test is a literal
// expect(fn(input)).toEqual(output). tier-colors.ts is itself a pure,
// zero-dependency module, so importing rarityIndex from it keeps this file
// in the functional core.

import { rarityIndex } from "@/lib/tier-colors";

// The minimal season shape titleStickers needs -- a structural subset of
// SeasonHistoryEntry (web/lib/profile.ts) so this module stays decoupled
// from the loader's full shape and is trivial to test with plain literals.
// SeasonHistoryEntry already has these three fields with these exact types,
// so callers can pass it straight through with no mapping.
export interface SeasonForStickers {
  tierName: string;
  tierPosition: number;
  rank: number;
}

export interface TitleSticker {
  tierName: string;
  rarity: number;
  count: number;
}

// Groups division titles -- seasons this player finished rank 1 in -- by
// tier, in tier-ladder order (best/lowest tierPosition first, same ordering
// rarityIndex/tierColors use everywhere else on the site). A season only
// counts as a title when it has a real cached rank (rank > 0 -- rank 0
// means no DivisionStandings cache row exists yet for that division, so it
// can't be claimed as a win). This is the "won the division" definition
// the season-history cards already use (see ProfileView's gold-edge check).
export function titleStickers(seasons: readonly SeasonForStickers[]): TitleSticker[] {
  const byTier = new Map<string, { position: number; rarity: number; count: number }>();
  for (const s of seasons) {
    if (s.rank !== 1) continue;
    const existing = byTier.get(s.tierName);
    if (existing) {
      existing.count += 1;
    } else {
      byTier.set(s.tierName, { position: s.tierPosition, rarity: rarityIndex(s.tierPosition), count: 1 });
    }
  }
  return [...byTier.entries()]
    .sort((a, b) => a[1].position - b[1].position)
    .map(([tierName, v]) => ({ tierName, rarity: v.rarity, count: v.count }));
}

// The minimal per-game shape netLivesForGames needs -- mirrors GamePlayed's
// iWon/lives fields (web/lib/profile.ts). Same sign convention as
// computeNetLives (web/lib/standings.ts): a game with no recorded lives, or
// an indeterminate winner, contributes 0.
export interface GameForNetLives {
  iWon: boolean | null;
  lives: number | null;
}

// Net life differential across a set of games -- positive means this player
// generally finished games with more lives left than their opponents did.
export function netLivesForGames(games: readonly GameForNetLives[]): number {
  let net = 0;
  for (const g of games) {
    if (g.lives == null || g.iWon == null) continue;
    net += g.iWon ? g.lives : -g.lives;
  }
  return net;
}

// Up to two initials for the avatar fallback circle, uppercased.
// "Jane Doe" -> "JD", "solo" -> "S", "" / whitespace-only -> "?".
export function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

// Per-season input flattenMatchesNewestFirst needs -- a structural subset
// of SeasonHistoryEntry, generic over the match entry type so callers keep
// their full MatchEntry (pairingId, games, uncounted, etc.) attached for
// rendering dispute forms / pick-ban details on the flattened result.
export interface SeasonForMatchHands<M> {
  seasonName: string;
  divisionName: string;
  isActive: boolean;
  matches: readonly M[];
}

export interface MatchHandContext {
  seasonName: string;
  divisionName: string;
  isActiveSeason: boolean;
}

export interface MatchHand<M> {
  match: M;
  context: MatchHandContext;
}

// Flattens every match across every season into one newest-first list (by
// confirmedAt), each tagged with the season/division it came from. A match
// with no confirmedAt (shouldn't happen for CONFIRMED/DISPUTED matches, but
// the type allows it) sorts to the end rather than throwing.
export function flattenMatchesNewestFirst<M extends { confirmedAt: Date | null }>(
  seasons: readonly SeasonForMatchHands<M>[],
): MatchHand<M>[] {
  const all: MatchHand<M>[] = [];
  for (const s of seasons) {
    for (const match of s.matches) {
      all.push({
        match,
        context: { seasonName: s.seasonName, divisionName: s.divisionName, isActiveSeason: s.isActive },
      });
    }
  }
  all.sort((a, b) => {
    const at = a.match.confirmedAt ? a.match.confirmedAt.getTime() : -Infinity;
    const bt = b.match.confirmedAt ? b.match.confirmedAt.getTime() : -Infinity;
    return bt - at;
  });
  return all;
}
