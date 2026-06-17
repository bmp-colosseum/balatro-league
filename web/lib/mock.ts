// Identify fake/test players so they don't appear in public views.
// No dash — startsWith still matches legacy "mock-"/"sim-" ids AND new dashless
// ones, so detection is backward-compatible while new ids are dash-free.
const PREFIXES = ["mock", "sim"] as const;

// Generic so .filter() callers preserve their original element type.
export function isMockPlayer<T extends { discordId: string }>(player: T): boolean {
  return PREFIXES.some((p) => player.discordId.startsWith(p));
}
