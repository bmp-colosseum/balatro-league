// Pure helpers for rendering a Discord member's avatar on the web. No I/O --
// callers pass in the already-fetched discordId + GuildMember.avatar hash
// (see web/lib/loaders/standings.ts, division.ts, @/lib/profile.ts).

// Builds the CDN URL for a Discord user's custom avatar, or null when they
// have none (caller falls back to initials/a placeholder). Animated avatars
// (hash starts with "a_") are served as .gif so they actually animate;
// everything else as .png. `size` must be a power of two per Discord's CDN
// contract (16-4096) -- callers pick one of their own fixed sizes, so no
// validation is done here.
export function discordAvatarUrl(
  discordId: string,
  hash: string | null | undefined,
  size = 64,
): string | null {
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=${size}`;
}

// Up-to-2-letter initials fallback for when a player has no avatar hash --
// first letters of up to the first two whitespace-separated words, upper-cased.
// Empty/whitespace-only input returns "" (caller decides the final fallback).
export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
