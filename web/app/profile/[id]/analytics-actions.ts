"use server";

// Read-only server action backing the collapsed "Your deck & stake stats"
// section on /profile/[id] and /me (ProfileAnalyticsSection). Deck/stake
// performance and favourites are already computed for free as a byproduct of
// the match-history query every profile view already pays for (see
// lib/profile.ts's loadPlayerHistory) — ban stats are a SEPARATE full scan of
// every confirmed game's pick/ban pool (loadPlayerBanStats), so this is the
// one query actually worth deferring until the section is opened.

import { loadPlayerBanStats, type PlayerBanStats } from "@/lib/profile";

export async function loadDeckStakeAnalyticsAction(playerId: string): Promise<PlayerBanStats> {
  return loadPlayerBanStats(playerId);
}
