import { cache } from "react";

// Resolve a person's Team Tour profile PATH by their Discord id, server-side, via the Tour's
// authenticated resolver -- so we can link to it WITHOUT putting the raw Discord id in public
// page source. Best-effort: returns null (no link rendered) when unconfigured, not found, or the
// Tour is unreachable, so a profile page never breaks on it. Cached per render + 1h at the fetch
// layer (a person's Discord id -> Tour profile mapping is effectively static).
export const tourProfilePath = cache(async (discordId: string): Promise<string | null> => {
  const base = process.env.TOUR_INTERNAL_URL || process.env.TOUR_URL || process.env.NEXT_PUBLIC_TOUR_URL;
  const token = process.env.TOUR_ADMIN_TOKEN;
  if (!base || !token || !/^\d+$/.test(discordId)) return null;
  try {
    const r = await fetch(`${base}/api/profile/by-discord/${discordId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      next: { revalidate: 3600 },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { found?: boolean; path?: string };
    return d.found && d.path ? d.path : null;
  } catch {
    return null;
  }
});

// The Team Tour site's public base URL for building the outbound href.
export const TOUR_PUBLIC_URL = process.env.NEXT_PUBLIC_TOUR_URL || "https://tour.balatroleague.com";
