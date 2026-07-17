// One place for "what season are players currently looking at?" — the currently active season.
// Visibility filtering is gone (was used to hide test seasons on prod; we have a dedicated
// dev stack now), so admin and player-facing callers can share this same lookup.
//
// Cached in-process with a short TTL: activePublicSeason() is called at the top of nearly
// every command/button and on every autocomplete keystroke, so an uncached DB round-trip
// here sits inside Discord's 3s ack window on 100% of interactions. The active season
// changes at most once per transition; a <=30s propagation delay is harmless. Callers that
// mutate isActive should call invalidateActiveSeasonCache() to reflect it immediately.

import type { Season } from "@prisma/client";
import { prisma } from "./db.js";

const TTL_MS = 30 * 1000;
let cache: { value: Season | null; expiresAt: number } | null = null;

export async function activePublicSeason(): Promise<Season | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await prisma.season.findFirst({ where: { isActive: true } });
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export function invalidateActiveSeasonCache(): void {
  cache = null;
}
